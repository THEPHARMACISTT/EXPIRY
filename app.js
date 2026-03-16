/**
 * PharmaScan Pro v5.0
 * GS1 Barcode Scanner for OASIS PHARMACY / Alshaya-Boots
 * Database: GTIN | BARCODE | RMS CODE | DESCRIPTION | BRAND | SUPPLIER
 */

const CONFIG = {
  DB_NAME: 'PharmaScanProV5',
  DB_VERSION: 5,
  STORE_NO: '31374',
  STORE_NAME: 'T3 ARRIVAL',
  EXPIRY_DAYS: 90,
  VERSION: '5.0.0'
};

// App State
const App = {
  db: null,
  master: new Map(),      // barcode/gtin -> product
  masterRMS: new Map(),   // RMS -> product
  scanner: { active: false, instance: null },
  currentScan: null,
  editingId: null
};

// ============================================
// GS1 PARSER
// ============================================
const GS1 = {
  parse(code) {
    const r = { raw: code || '', gtin: '', gtin14: '', barcode: '', expiry: '', expiryISO: '', expiryDisplay: '', batch: '', serial: '', qty: 1, isGS1: false };
    if (!code) return r;
    
    code = code.trim().replace(/[\r\n\t]/g, '');
    
    // Remove prefixes
    [']C1', ']e0', ']E0', ']d2', ']Q3'].forEach(p => { if (code.startsWith(p)) code = code.slice(p.length); });
    
    // Normalize FNC1
    code = code.replace(/[\x1d\x1e\x1c~]/g, '\x1d').replace(/\[FNC1\]|<GS>|\{GS\}/gi, '\x1d');
    
    // Check if GS1
    if (code.includes('\x1d') || /\(\d{2,4}\)/.test(code) || (/^(01|02|10|17|21)\d/.test(code) && code.length > 16)) {
      r.isGS1 = true;
      this.parseGS1(code, r);
    } else {
      // Simple barcode
      const digits = code.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 14) {
        r.barcode = digits;
        r.gtin14 = digits.padStart(14, '0');
      }
    }
    
    return r;
  },

  parseGS1(code, r) {
    // Parentheses format
    if (code.includes('(')) {
      let m = code.match(/\(01\)(\d{14})/); if (m) { r.gtin14 = m[1]; r.gtin = m[1]; r.barcode = m[1].slice(-13); }
      m = code.match(/\(17\)(\d{6})/) || code.match(/\(15\)(\d{6})/); if (m) this.parseDate(m[1], r);
      m = code.match(/\(10\)([^\(]+)/); if (m) r.batch = m[1].trim().slice(0, 20);
      m = code.match(/\(21\)([^\(]+)/); if (m) r.serial = m[1].trim().slice(0, 20);
      return;
    }
    
    // Raw AI format
    let pos = 0, len = code.length;
    while (pos < len) {
      if (code[pos] === '\x1d') { pos++; continue; }
      const ai = code.slice(pos, pos + 2);
      
      if (ai === '01' || ai === '02') {
        r.gtin14 = code.slice(pos + 2, pos + 16);
        r.gtin = r.gtin14;
        r.barcode = r.gtin14.slice(-13);
        pos += 16;
      } else if (ai === '17' || ai === '15') {
        this.parseDate(code.slice(pos + 2, pos + 8), r);
        pos += 8;
      } else if (ai === '10') {
        pos += 2;
        let batch = '';
        while (pos < len && code[pos] !== '\x1d') batch += code[pos++];
        r.batch = batch.slice(0, 20);
      } else if (ai === '21') {
        pos += 2;
        while (pos < len && code[pos] !== '\x1d') pos++;
      } else if (ai === '11' || ai === '12' || ai === '13') {
        pos += 8;
      } else {
        pos++;
      }
    }
  },

  parseDate(yymmdd, r) {
    if (!yymmdd || yymmdd.length !== 6) return;
    const yy = parseInt(yymmdd.slice(0, 2)), mm = parseInt(yymmdd.slice(2, 4));
    let dd = parseInt(yymmdd.slice(4, 6));
    if (isNaN(yy) || isNaN(mm) || isNaN(dd) || mm < 1 || mm > 12) return;
    const year = yy >= 51 ? 1900 + yy : 2000 + yy;
    if (dd === 0) dd = new Date(year, mm, 0).getDate();
    r.expiry = yymmdd;
    r.expiryISO = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    r.expiryDisplay = `${String(dd).padStart(2, '0')}/${String(mm).padStart(2, '0')}/${year}`;
  },

  getStatus(iso) {
    if (!iso) return 'unknown';
    const today = new Date(); today.setHours(0,0,0,0);
    const exp = new Date(iso); exp.setHours(0,0,0,0);
    const days = Math.floor((exp - today) / 86400000);
    return days < 0 ? 'expired' : days <= CONFIG.EXPIRY_DAYS ? 'expiring' : 'ok';
  },

  getDays(iso) {
    if (!iso) return Infinity;
    const today = new Date(); today.setHours(0,0,0,0);
    const exp = new Date(iso); exp.setHours(0,0,0,0);
    return Math.floor((exp - today) / 86400000);
  }
};

// ============================================
// MATCHER - Fast product lookup
// ============================================
const Matcher = {
  build(data) {
    App.master.clear();
    App.masterRMS.clear();
    
    for (const item of data) {
      const product = {
        gtin: String(item.gtin || '').trim(),
        barcode: String(item.barcode || '').trim(),
        rms: String(item.rms || item.rmsCode || item['rms code'] || item['RMS CODE'] || '').trim(),
        description: String(item.description || item.name || item.DESCRIPTION || '').trim(),
        brand: String(item.brand || item.BRAND || '').trim(),
        supplier: String(item.supplier || item.supplierName || item['SUPPLIER NAME'] || item['supplier name'] || '').trim(),
        conceptGroup: String(item.conceptGroup || item['CONCEPT GROUP'] || item['concept group'] || '').trim(),
        returnPolicy: String(item.returnPolicy || item['RETURN POLICY'] || item['return policy'] || '').trim(),
        keyBrands: String(item.keyBrands || item['KEY BRANDS'] || item['key brands'] || '').trim()
      };
      
      // Index by GTIN (14 digits)
      if (product.gtin && product.gtin.length >= 8) {
        const g = product.gtin.replace(/\D/g, '');
        App.master.set(g, product);
        App.master.set(g.padStart(14, '0'), product);
        App.master.set(g.slice(-13), product);
        App.master.set(g.slice(-12), product);
      }
      
      // Index by Barcode (EAN-13/12)
      if (product.barcode && product.barcode.length >= 8) {
        const bc = product.barcode.replace(/\D/g, '');
        App.master.set(bc, product);
        App.master.set(bc.padStart(14, '0'), product);
        App.master.set(bc.slice(-13), product);
        App.master.set(bc.slice(-12), product);
        App.master.set(bc.slice(-8), product);
      }
      
      // Index by RMS
      if (product.rms) {
        App.masterRMS.set(product.rms, product);
        App.masterRMS.set(product.rms.replace(/\D/g, ''), product);
      }
    }
    
    console.log(`✅ Indexed ${App.master.size} codes, ${App.masterRMS.size} RMS`);
  },

  find(code) {
    if (!code) return null;
    code = String(code).trim();
    const clean = code.replace(/\D/g, '');
    
    // Try direct match
    if (App.master.has(code)) return { ...App.master.get(code), matchType: 'EXACT' };
    if (App.master.has(clean)) return { ...App.master.get(clean), matchType: 'BARCODE' };
    if (App.master.has(clean.padStart(14, '0'))) return { ...App.master.get(clean.padStart(14, '0')), matchType: 'GTIN14' };
    if (App.master.has(clean.slice(-13))) return { ...App.master.get(clean.slice(-13)), matchType: 'GTIN13' };
    if (App.master.has(clean.slice(-12))) return { ...App.master.get(clean.slice(-12)), matchType: 'GTIN12' };
    if (App.master.has(clean.slice(-8))) return { ...App.master.get(clean.slice(-8)), matchType: 'PARTIAL' };
    
    // Try RMS
    if (App.masterRMS.has(code)) return { ...App.masterRMS.get(code), matchType: 'RMS' };
    if (App.masterRMS.has(clean)) return { ...App.masterRMS.get(clean), matchType: 'RMS' };
    
    return null;
  },

  addProduct(item) {
    const product = {
      gtin: String(item.gtin || '').trim(),
      barcode: String(item.barcode || '').trim(),
      rms: String(item.rms || '').trim(),
      description: String(item.description || item.name || '').trim(),
      brand: String(item.brand || '').trim(),
      supplier: String(item.supplier || '').trim(),
      returnPolicy: String(item.returnPolicy || 'YES').trim()
    };
    
    // Index
    const bc = (product.barcode || product.gtin || '').replace(/\D/g, '');
    if (bc.length >= 8) {
      App.master.set(bc, product);
      App.master.set(bc.padStart(14, '0'), product);
      App.master.set(bc.slice(-13), product);
    }
    if (product.rms) {
      App.masterRMS.set(product.rms, product);
    }
    
    return product;
  }
};

// ============================================
// DATABASE
// ============================================
const DB = {
  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { App.db = req.result; resolve(); };
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('history')) {
          db.createObjectStore('history', { keyPath: 'id', autoIncrement: true }).createIndex('timestamp', 'timestamp');
        }
        if (!db.objectStoreNames.contains('master')) {
          db.createObjectStore('master', { keyPath: 'id', autoIncrement: true });
        }
      };
    });
  },

  tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = App.db.transaction(store, mode);
      const s = t.objectStore(store);
      const r = fn(s);
      if (r?.onsuccess !== undefined) { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }
      else { t.oncomplete = () => resolve(r); t.onerror = () => reject(t.error); }
    });
  },

  addHistory: (item) => { item.timestamp = Date.now(); return DB.tx('history', 'readwrite', s => s.add(item)); },
  updateHistory: (item) => DB.tx('history', 'readwrite', s => s.put(item)),
  getHistory: (id) => DB.tx('history', 'readonly', s => s.get(id)),
  getAllHistory: () => DB.tx('history', 'readonly', s => s.getAll()),
  deleteHistory: (id) => DB.tx('history', 'readwrite', s => s.delete(id)),
  clearHistory: () => DB.tx('history', 'readwrite', s => s.clear()),
  getAllMaster: () => DB.tx('master', 'readonly', s => s.getAll()),
  clearMaster: () => DB.tx('master', 'readwrite', s => s.clear()),

  async bulkAddMaster(items) {
    return new Promise((resolve, reject) => {
      const t = App.db.transaction('master', 'readwrite');
      const s = t.objectStore('master');
      let c = 0;
      for (const item of items) { s.add(item); c++; }
      t.oncomplete = () => resolve(c);
      t.onerror = () => reject(t.error);
    });
  }
};

// ============================================
// SCANNER
// ============================================
const Scanner = {
  async toggle() { App.scanner.active ? await this.stop() : await this.start(); },

  async start() {
    try {
      if (!App.scanner.instance) App.scanner.instance = new Html5Qrcode('reader');
      await App.scanner.instance.start(
        { facingMode: 'environment' },
        { fps: 15, qrbox: { width: 250, height: 150 } },
        code => this.onScan(code),
        () => {}
      );
      App.scanner.active = true;
      document.getElementById('scannerPlaceholder').classList.add('hidden');
      document.getElementById('viewfinder').classList.add('active');
      document.getElementById('btnScannerText').textContent = 'Stop';
      document.getElementById('btnScanner').classList.add('stop');
      haptic();
    } catch (e) {
      toast('Camera error: ' + e.message, 'error');
    }
  },

  async stop() {
    try { if (App.scanner.instance && App.scanner.active) await App.scanner.instance.stop(); } catch {}
    App.scanner.active = false;
    document.getElementById('scannerPlaceholder')?.classList.remove('hidden');
    document.getElementById('viewfinder')?.classList.remove('active');
    document.getElementById('btnScannerText').textContent = 'Start Scanner';
    document.getElementById('btnScanner')?.classList.remove('stop');
  },

  async onScan(code) {
    await this.stop();
    haptic();
    processBarcode(code);
  }
};

// ============================================
// BARCODE PROCESSING
// ============================================
function processBarcode(code) {
  if (!code) return;
  code = code.trim();
  if (!code) return;
  
  console.log('📷 Scanned:', code);
  
  // Parse GS1
  const parsed = GS1.parse(code);
  console.log('📊 Parsed:', parsed);
  
  // Find product
  let product = null;
  if (parsed.gtin14) product = Matcher.find(parsed.gtin14);
  if (!product && parsed.barcode) product = Matcher.find(parsed.barcode);
  if (!product) product = Matcher.find(code);
  
  // Show widget
  showScanWidget(parsed, product);
  
  document.getElementById('manualInput').value = '';
}

// ============================================
// SCAN WIDGET
// ============================================
function showScanWidget(parsed, product) {
  const found = product && product.description;
  
  App.currentScan = { parsed, product, found };
  
  // Update status
  document.getElementById('srwIcon').textContent = found ? '✅' : '⚠️';
  document.getElementById('srwStatus').textContent = found ? 'PRODUCT FOUND' : 'NEW PRODUCT';
  document.getElementById('srwStatus').className = `srw-status ${found ? 'found' : 'notfound'}`;
  
  // Warning for non-returnable
  const isNonReturnable = product?.returnPolicy?.toUpperCase().includes('NO') || 
                          product?.returnPolicy?.toUpperCase().includes('NON');
  document.getElementById('srwWarning').classList.toggle('hidden', !isNonReturnable);
  
  // Fill fields
  document.getElementById('srwName').value = product?.description || '';
  document.getElementById('srwName').readOnly = found;
  document.getElementById('srwBrand').value = product?.brand || '';
  document.getElementById('srwBrand').readOnly = found;
  document.getElementById('srwSupplier').value = product?.supplier || '';
  document.getElementById('srwSupplier').readOnly = found;
  
  // Codes
  document.getElementById('srwGTIN').textContent = product?.gtin || parsed.gtin14 || '-';
  document.getElementById('srwBarcode').textContent = product?.barcode || parsed.barcode || '-';
  document.getElementById('srwRMS').value = product?.rms || '';
  document.getElementById('srwRMS').readOnly = found;
  document.getElementById('srwReturn').textContent = product?.returnPolicy || '-';
  
  // Expiry & Batch
  document.getElementById('srwExpiry').value = parsed.expiry || '';
  document.getElementById('srwExpiryISO').value = parsed.expiryISO || '';
  document.getElementById('srwBatch').value = parsed.batch || '';
  document.getElementById('srwQty').value = 1;
  
  // Update expiry preview
  updateExpiryPreview();
  
  // Buttons
  document.getElementById('srwSave').classList.toggle('hidden', !found);
  document.getElementById('srwAddMaster').classList.toggle('hidden', found);
  
  // Show widget
  document.getElementById('scanWidget').classList.add('show');
  
  // Focus
  setTimeout(() => {
    if (!found) document.getElementById('srwName').focus();
    else if (!parsed.expiry) document.getElementById('srwExpiry').focus();
    else document.getElementById('srwBatch').focus();
  }, 300);
}

function updateExpiryPreview() {
  const input = document.getElementById('srwExpiry').value;
  const preview = document.getElementById('expiryPreview');
  
  if (!input || input.length < 6) {
    preview.classList.remove('show');
    return;
  }
  
  const dd = parseInt(input.slice(0, 2));
  const mm = parseInt(input.slice(2, 4));
  const yy = parseInt(input.slice(4, 6));
  
  if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    const iso = `${year}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
    document.getElementById('srwExpiryISO').value = iso;
    
    const status = GS1.getStatus(iso);
    const days = GS1.getDays(iso);
    
    preview.textContent = `📅 ${dd}/${mm}/${year} — ${status === 'expired' ? 'EXPIRED' : days + ' days left'}`;
    preview.className = `expiry-preview show ${status === 'expired' ? 'danger' : status === 'expiring' ? 'warning' : 'ok'}`;
  } else {
    preview.classList.remove('show');
  }
}

function hideScanWidget() {
  document.getElementById('scanWidget').classList.remove('show');
  App.currentScan = null;
}

async function saveScanResult() {
  const { parsed, product } = App.currentScan;
  
  const entry = {
    raw: parsed.raw,
    gtin: product?.gtin || parsed.gtin14 || '',
    barcode: product?.barcode || parsed.barcode || '',
    rms: document.getElementById('srwRMS').value.trim(),
    description: document.getElementById('srwName').value.trim() || 'Unknown',
    brand: document.getElementById('srwBrand').value.trim(),
    supplier: document.getElementById('srwSupplier').value.trim(),
    returnPolicy: product?.returnPolicy || '',
    expiryISO: document.getElementById('srwExpiryISO').value,
    expiryDisplay: formatDateDisplay(document.getElementById('srwExpiryISO').value),
    batch: document.getElementById('srwBatch').value.trim().toUpperCase(),
    qty: parseInt(document.getElementById('srwQty').value) || 1,
    isGS1: parsed.isGS1,
    timestamp: Date.now()
  };
  
  await DB.addHistory(entry);
  hideScanWidget();
  toast('Saved: ' + entry.description, 'success');
  haptic();
  await refreshUI();
}

async function saveAsNewProduct() {
  const { parsed } = App.currentScan;
  const barcode = parsed.barcode || parsed.gtin14 || parsed.raw.replace(/\D/g, '');
  
  const name = document.getElementById('srwName').value.trim();
  if (!name) {
    toast('Enter product name', 'error');
    document.getElementById('srwName').focus();
    return;
  }
  
  // Create product
  const newProduct = {
    gtin: parsed.gtin14 || '',
    barcode: barcode,
    rms: document.getElementById('srwRMS').value.trim(),
    description: name,
    brand: document.getElementById('srwBrand').value.trim(),
    supplier: document.getElementById('srwSupplier').value.trim(),
    returnPolicy: 'YES'
  };
  
  // Add to master
  Matcher.addProduct(newProduct);
  
  // Also save to history
  const entry = {
    ...newProduct,
    raw: parsed.raw,
    expiryISO: document.getElementById('srwExpiryISO').value,
    expiryDisplay: formatDateDisplay(document.getElementById('srwExpiryISO').value),
    batch: document.getElementById('srwBatch').value.trim().toUpperCase(),
    qty: parseInt(document.getElementById('srwQty').value) || 1,
    isGS1: parsed.isGS1,
    isNew: true
  };
  
  await DB.addHistory(entry);
  hideScanWidget();
  toast('✅ Added to Master & saved!', 'success');
  haptic();
  await refreshUI();
}

// ============================================
// UI REFRESH
// ============================================
async function refreshUI() {
  const [history, master] = await Promise.all([DB.getAllHistory(), DB.getAllMaster()]);
  
  // Build matcher
  if (master.length > 0) Matcher.build(master);
  
  // Stats
  document.getElementById('statMaster').textContent = App.master.size;
  document.getElementById('statItems').textContent = history.length;
  
  const expiring = history.filter(h => GS1.getStatus(h.expiryISO) === 'expiring' || GS1.getStatus(h.expiryISO) === 'expired').length;
  document.getElementById('statExpiring').textContent = expiring;
  
  // Render history
  renderHistory(history);
}

function renderHistory(history) {
  const container = document.getElementById('historyList');
  const empty = document.getElementById('historyEmpty');
  
  if (!history.length) {
    container.innerHTML = '';
    container.appendChild(empty);
    empty.classList.remove('hidden');
    return;
  }
  
  empty.classList.add('hidden');
  history.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  
  container.innerHTML = history.map(item => {
    const status = GS1.getStatus(item.expiryISO);
    const days = GS1.getDays(item.expiryISO);
    const isNR = item.returnPolicy?.toUpperCase().includes('NO');
    
    let badge = '';
    if (status === 'expired') badge = '<span class="badge badge-exp">EXPIRED</span>';
    else if (status === 'expiring') badge = `<span class="badge badge-warn">${days}d</span>`;
    else if (status === 'ok') badge = `<span class="badge badge-ok">${days}d</span>`;
    
    return `
      <div class="h-item" onclick="editItem(${item.id})">
        <div class="h-icon ${status}">${item.isGS1 ? '📊' : '📦'}</div>
        <div class="h-info">
          <div class="h-name">${escapeHtml(item.description)}</div>
          <div class="h-meta">${item.expiryDisplay || '-'} • ${item.batch || '-'}</div>
          <div class="h-badges">
            ${badge}
            ${isNR ? '<span class="badge badge-nr">🚫 NR</span>' : ''}
            <span class="badge badge-qty">×${item.qty || 1}</span>
          </div>
        </div>
        <div class="h-qty" onclick="event.stopPropagation()">
          <button class="qty-btn" onclick="adjustQty(${item.id},-1)">−</button>
          <span class="qty-val">${item.qty || 1}</span>
          <button class="qty-btn" onclick="adjustQty(${item.id},1)">+</button>
        </div>
        <button class="h-del" onclick="event.stopPropagation();deleteItem(${item.id})">🗑️</button>
      </div>
    `;
  }).join('');
}

async function adjustQty(id, delta) {
  const item = await DB.getHistory(id);
  if (item) {
    item.qty = Math.max(1, (item.qty || 1) + delta);
    await DB.updateHistory(item);
    haptic();
    await refreshUI();
  }
}

async function deleteItem(id) {
  if (confirm('Delete this item?')) {
    await DB.deleteHistory(id);
    toast('Deleted', 'success');
    await refreshUI();
  }
}

// ============================================
// EDIT MODAL
// ============================================
async function editItem(id) {
  const item = await DB.getHistory(id);
  if (!item) return;
  
  App.editingId = id;
  document.getElementById('editName').value = item.description || '';
  document.getElementById('editExpiry').value = item.expiryISO || '';
  document.getElementById('editBatch').value = item.batch || '';
  document.getElementById('editQty').value = item.qty || 1;
  document.getElementById('editRMS').value = item.rms || '';
  document.getElementById('editModal').classList.add('show');
}

async function saveEdit() {
  const item = await DB.getHistory(App.editingId);
  if (!item) return;
  
  item.description = document.getElementById('editName').value.trim();
  item.expiryISO = document.getElementById('editExpiry').value;
  item.expiryDisplay = formatDateDisplay(item.expiryISO);
  item.batch = document.getElementById('editBatch').value.trim().toUpperCase();
  item.qty = parseInt(document.getElementById('editQty').value) || 1;
  item.rms = document.getElementById('editRMS').value.trim();
  
  await DB.updateHistory(item);
  closeEditModal();
  await refreshUI();
  toast('Saved', 'success');
}

function closeEditModal() {
  document.getElementById('editModal').classList.remove('show');
  App.editingId = null;
}

// ============================================
// EXPORT
// ============================================
async function exportCSV() {
  const history = await DB.getAllHistory();
  if (!history.length) { toast('No data', 'warning'); return; }
  
  const headers = ['STORE NO', 'STORE NAME', 'GTIN', 'BARCODE', 'RMS CODE', 'DESCRIPTION', 'BRAND', 'SUPPLIER', 'QTY', 'EXPIRY DATE', 'BATCH NO', 'RETURN POLICY', 'STATUS'];
  
  const rows = history.map(h => [
    CONFIG.STORE_NO,
    CONFIG.STORE_NAME,
    h.gtin || '',
    h.barcode || '',
    h.rms || '',
    h.description || '',
    h.brand || '',
    h.supplier || '',
    h.qty || 1,
    h.expiryDisplay || '',
    h.batch || '',
    h.returnPolicy || '',
    GS1.getStatus(h.expiryISO).toUpperCase()
  ]);
  
  let csv = headers.join(',') + '\n';
  rows.forEach(row => { csv += row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',') + '\n'; });
  
  download(csv, `pharmascan-${formatDateFile()}.csv`, 'text/csv');
  toast('Exported CSV', 'success');
}

async function exportTSV() {
  const history = await DB.getAllHistory();
  if (!history.length) { toast('No data', 'warning'); return; }
  
  const headers = ['RMS CODE', 'BARCODE', 'DESCRIPTION', 'QTY', 'EXPIRY DATE', 'BATCH NO', 'STORE NO', 'STORE NAME'];
  
  const rows = history.map(h => [
    h.rms || '',
    h.barcode || h.gtin || '',
    h.description || '',
    h.qty || 1,
    h.expiryDisplay || '',
    h.batch || '',
    CONFIG.STORE_NO,
    CONFIG.STORE_NAME
  ]);
  
  let tsv = headers.join('\t') + '\n';
  rows.forEach(row => { tsv += row.join('\t') + '\n'; });
  
  download(tsv, `pharmascan-${formatDateFile()}.tsv`, 'text/tab-separated-values');
  toast('Exported TSV', 'success');
}

// ============================================
// MASTER DATA
// ============================================
async function uploadMaster(file) {
  try {
    const text = await file.text();
    const lines = text.trim().split(/[\r\n]+/);
    if (lines.length < 2) { toast('Invalid file', 'error'); return; }
    
    const delim = lines[0].includes('\t') ? '\t' : ',';
    const cols = lines[0].toLowerCase().split(delim).map(c => c.trim().replace(/['"]/g, ''));
    
    console.log('📊 Columns:', cols);
    
    // Find columns
    const idx = {
      gtin: cols.findIndex(c => /^gtin/.test(c)),
      barcode: cols.findIndex(c => /^barcode/.test(c)),
      rms: cols.findIndex(c => /rms/.test(c)),
      description: cols.findIndex(c => /description|name/.test(c)),
      brand: cols.findIndex(c => /^brand/.test(c)),
      supplier: cols.findIndex(c => /supplier/.test(c)),
      concept: cols.findIndex(c => /concept/.test(c)),
      returnPolicy: cols.findIndex(c => /return/.test(c)),
      keyBrands: cols.findIndex(c => /key.*brand/.test(c))
    };
    
    console.log('📋 Indexes:', idx);
    
    if (idx.barcode === -1 && idx.gtin === -1) { toast('No barcode/GTIN column', 'error'); return; }
    
    const items = [];
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(delim).map(c => c.trim().replace(/^["']|["']$/g, ''));
      
      const item = {
        gtin: idx.gtin >= 0 ? row[idx.gtin] : '',
        barcode: idx.barcode >= 0 ? row[idx.barcode] : '',
        rms: idx.rms >= 0 ? row[idx.rms] : '',
        description: idx.description >= 0 ? row[idx.description] : '',
        brand: idx.brand >= 0 ? row[idx.brand] : '',
        supplier: idx.supplier >= 0 ? row[idx.supplier] : '',
        conceptGroup: idx.concept >= 0 ? row[idx.concept] : '',
        returnPolicy: idx.returnPolicy >= 0 ? row[idx.returnPolicy] : '',
        keyBrands: idx.keyBrands >= 0 ? row[idx.keyBrands] : ''
      };
      
      if (item.gtin || item.barcode || item.rms) items.push(item);
    }
    
    // Clear and add
    await DB.clearMaster();
    const count = await DB.bulkAddMaster(items);
    Matcher.build(items);
    
    toast(`✅ Uploaded ${count} products`, 'success');
    await refreshUI();
  } catch (e) {
    console.error(e);
    toast('Upload failed', 'error');
  }
}

async function backupMaster() {
  const master = await DB.getAllMaster();
  if (!master.length) { toast('No master data', 'warning'); return; }
  
  const backup = { version: CONFIG.VERSION, date: new Date().toISOString(), count: master.length, products: master };
  download(JSON.stringify(backup, null, 2), `master-backup-${formatDateFile()}.json`, 'application/json');
  toast(`Backed up ${master.length} products`, 'success');
}

async function clearMasterData() {
  if (!confirm('Clear ALL master data?')) return;
  await DB.clearMaster();
  App.master.clear();
  App.masterRMS.clear();
  toast('Master data cleared', 'success');
  await refreshUI();
}

// ============================================
// UTILITIES
// ============================================
function toast(msg, type = 'info') {
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${{success:'✓',error:'✕',warning:'⚠',info:'ℹ'}[type]}</span><span class="toast-msg">${escapeHtml(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2500);
}

function haptic() { if (navigator.vibrate) navigator.vibrate(10); }
function escapeHtml(s) { return s ? String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])) : ''; }
function formatDateDisplay(iso) { if (!iso) return ''; const [y,m,d] = iso.split('-'); return `${d}/${m}/${y}`; }
function formatDateFile() { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; }
function download(content, name, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], {type})); a.download = name; a.click(); }

function openMenu() { document.getElementById('menuBg').classList.add('show'); document.getElementById('sideMenu').classList.add('show'); }
function closeMenu() { document.getElementById('menuBg').classList.remove('show'); document.getElementById('sideMenu').classList.remove('show'); }

// ============================================
// EVENT LISTENERS
// ============================================
function setupEvents() {
  document.getElementById('btnMenu').onclick = openMenu;
  document.getElementById('menuBg').onclick = closeMenu;
  document.getElementById('menuClose').onclick = closeMenu;
  
  document.getElementById('btnScanner').onclick = () => Scanner.toggle();
  document.getElementById('scannerFrame').onclick = () => { if (!App.scanner.active) Scanner.start(); };
  
  document.getElementById('manualInput').onkeypress = e => { if (e.key === 'Enter') processBarcode(document.getElementById('manualInput').value); };
  document.getElementById('btnManualAdd').onclick = () => processBarcode(document.getElementById('manualInput').value);
  
  document.getElementById('btnExport').onclick = exportTSV;
  document.getElementById('btnClear').onclick = async () => { if (confirm('Clear history?')) { await DB.clearHistory(); await refreshUI(); toast('Cleared', 'success'); } };
  
  // Scan widget
  document.getElementById('srwClose').onclick = hideScanWidget;
  document.getElementById('srwCancel').onclick = hideScanWidget;
  document.getElementById('srwSave').onclick = saveScanResult;
  document.getElementById('srwAddMaster').onclick = saveAsNewProduct;
  document.getElementById('srwQtyMinus').onclick = () => { const i = document.getElementById('srwQty'); i.value = Math.max(1, parseInt(i.value) - 1); };
  document.getElementById('srwQtyPlus').onclick = () => { const i = document.getElementById('srwQty'); i.value = parseInt(i.value) + 1; };
  document.getElementById('srwExpiry').oninput = updateExpiryPreview;
  document.getElementById('srwExpiry').onkeyup = (e) => { if (e.target.value.length >= 6) document.getElementById('srwBatch').focus(); };
  document.getElementById('srwBatch').onkeyup = (e) => { if (e.key === 'Enter') document.getElementById('srwQty').focus(); };
  
  // Edit modal
  document.getElementById('editClose').onclick = closeEditModal;
  document.getElementById('editModal').onclick = e => { if (e.target.id === 'editModal') closeEditModal(); };
  document.getElementById('editSave').onclick = saveEdit;
  document.getElementById('editDelete').onclick = async () => { if (confirm('Delete?')) { await DB.deleteHistory(App.editingId); closeEditModal(); await refreshUI(); toast('Deleted', 'success'); } };
  
  // Menu items
  document.getElementById('menuUpload').onclick = () => { closeMenu(); document.getElementById('fileUpload').click(); };
  document.getElementById('fileUpload').onchange = e => { if (e.target.files[0]) { uploadMaster(e.target.files[0]); e.target.value = ''; } };
  document.getElementById('menuBackup').onclick = () => { closeMenu(); backupMaster(); };
  document.getElementById('menuClearMaster').onclick = () => { closeMenu(); clearMasterData(); };
  document.getElementById('menuExportCSV').onclick = () => { closeMenu(); exportCSV(); };
  document.getElementById('menuExportTSV').onclick = () => { closeMenu(); exportTSV(); };
  document.getElementById('menuClearHistory').onclick = async () => { closeMenu(); if (confirm('Clear history?')) { await DB.clearHistory(); await refreshUI(); toast('Cleared', 'success'); } };
  document.getElementById('menuAbout').onclick = () => { closeMenu(); alert(`PharmaScan Pro v${CONFIG.VERSION}\n\nOASIS PHARMACY\nStore: ${CONFIG.STORE_NO} - ${CONFIG.STORE_NAME}`); };
  
  // Offline
  window.addEventListener('online', () => document.getElementById('offlineTag').classList.remove('show'));
  window.addEventListener('offline', () => document.getElementById('offlineTag').classList.add('show'));
}

// ============================================
// INIT
// ============================================
async function init() {
  console.log('🚀 PharmaScan Pro v' + CONFIG.VERSION);
  
  try {
    await DB.init();
    setupEvents();
    await refreshUI();
    
    if (!navigator.onLine) document.getElementById('offlineTag').classList.add('show');
    console.log('✅ Ready');
  } catch (e) {
    console.error(e);
    toast('Init error', 'error');
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
