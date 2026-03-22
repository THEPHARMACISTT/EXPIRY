 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/app.js b/app.js
index df48a65cc27f3b7dc07f8b848b9eecf55ed6bfb6..ab20387bfea0d63edb154b9a3664f559f9971a39 100644
--- a/app.js
+++ b/app.js
@@ -165,98 +165,104 @@ const Haptic = {
 function parseGS1(raw) {
   const result = {
     valid: false,
     raw: raw,
     gtin14: '',
     gtin13: '',
     expiry: null,
     expiryDDMMYY: '',
     expiryFormatted: '',
     expiryStatus: 'missing',
     batch: '',
     serial: '',
     qty: 1,
     rms: ''
   };
   
   if (!raw || typeof raw !== 'string') return result;
   
   let code = raw.trim().replace(/\x1d/g, '|');
   
   // Convert raw to parenthesized format
   if (!code.includes('(') && /^\d{2}/.test(code)) {
     code = convertToParenthesized(code);
   }
   
-  // Extract fields
-  const patterns = {
-    gtin: /\(01\)(\d{12,14})/,
-    expiry: /\(17\)(\d{6})/,
-    batch: /\(10\)([^\(|\x1d]+)/,
-    serial: /\(21\)([^\(|\x1d]+)/,
-    qty: /\(30\)(\d+)/
-  };
+  const fields = extractAIFields(code);
   
   // GTIN
-  const gtinMatch = code.match(patterns.gtin);
-  if (gtinMatch) {
-    result.gtin14 = gtinMatch[1].padStart(14, '0');
+  if (fields['01']) {
+    result.gtin14 = fields['01'].replace(/\D/g, '').padStart(14, '0').slice(-14);
     result.gtin13 = result.gtin14.startsWith('0') ? result.gtin14.substring(1) : result.gtin14;
     result.valid = true;
   }
   
   // Expiry
-  const expiryMatch = code.match(patterns.expiry);
-  if (expiryMatch) {
-    const parsed = parseExpiryDate(expiryMatch[1]);
+  if (fields['17'] && /^\d{6}$/.test(fields['17'])) {
+    const parsed = parseExpiryDate(fields['17']);
     result.expiry = parsed.iso;
     result.expiryDDMMYY = parsed.ddmmyy;
     result.expiryFormatted = parsed.formatted;
     result.expiryStatus = calculateExpiryStatus(parsed.iso);
   }
   
   // Batch
-  const batchMatch = code.match(patterns.batch);
-  if (batchMatch) {
-    result.batch = batchMatch[1].replace(/\|/g, '').trim();
-  }
+  result.batch = normalizeBatch(fields['10'] || '');
   
   // Serial
-  const serialMatch = code.match(patterns.serial);
-  if (serialMatch) {
-    result.serial = serialMatch[1].replace(/\|/g, '').trim();
+  if (fields['21']) {
+    result.serial = fields['21'].replace(/\|/g, '').trim();
   }
   
   // Quantity
-  const qtyMatch = code.match(patterns.qty);
-  if (qtyMatch) {
-    result.qty = parseInt(qtyMatch[1]) || 1;
+  if (fields['30']) {
+    result.qty = parseInt(fields['30']) || 1;
   }
   
   return result;
 }
 
+function extractAIFields(code) {
+  const fields = {};
+  const regex = /\((\d{2,4})\)([^()]*)/g;
+  let match;
+  while ((match = regex.exec(code)) !== null) {
+    const ai = match[1];
+    const value = (match[2] || '').replace(/\|/g, '').trim();
+    if (!fields[ai]) fields[ai] = value;
+  }
+  return fields;
+}
+
+function normalizeBatch(batch) {
+  if (!batch) return '';
+  const cleaned = batch.toUpperCase().replace(/[^A-Z0-9]/g, '');
+  if (cleaned.length < 6) return '';
+  if (cleaned.length > 20) return cleaned.substring(0, 20);
+  return cleaned;
+}
+
 function convertToParenthesized(code) {
   const aiLengths = {
     '01': 14, '02': 14,
     '10': -1, '21': -1, '22': -1,
     '11': 6, '13': 6, '15': 6, '17': 6,
     '30': -1, '37': -1,
     '00': 18, '20': 2
   };
   
   let result = '';
   let pos = 0;
   
   while (pos < code.length) {
     const ai2 = code.substring(pos, pos + 2);
     const ai3 = code.substring(pos, pos + 3);
     
     let ai = '';
     let length = 0;
     
     if (aiLengths[ai2] !== undefined) {
       ai = ai2;
       length = aiLengths[ai2];
     } else if (aiLengths[ai3] !== undefined) {
       ai = ai3;
       length = aiLengths[ai3];
@@ -277,52 +283,52 @@ function convertToParenthesized(code) {
         if (char === '|' || char === '\x1d') { pos++; break; }
         const p2 = code.substring(pos, pos + 2);
         const p3 = code.substring(pos, pos + 3);
         if ((aiLengths[p2] !== undefined || aiLengths[p3] !== undefined) && value.length > 0) break;
         value += char;
         pos++;
       }
       result += `(${ai})${value}`;
     }
   }
   
   return result || code;
 }
 
 function parseExpiryDate(yymmdd) {
   const year = parseInt('20' + yymmdd.substring(0, 2));
   const month = parseInt(yymmdd.substring(2, 4));
   let day = parseInt(yymmdd.substring(4, 6));
   
   if (day === 0) day = new Date(year, month, 0).getDate();
   
   const date = new Date(year, month - 1, day);
   
   return {
     iso: date.toISOString().split('T')[0],
-    ddmmyy: `${String(day).padStart(2, '0')}${String(month).padStart(2, '0')}${yymmdd.substring(0, 2)}`,
-    formatted: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`
+    ddmmyy: `${String(day).padStart(2, '0')}${String(month).padStart(2, '0')}${year}`,
+    formatted: `${String(day).padStart(2, '0')}${String(month).padStart(2, '0')}${year}`
   };
 }
 
 function calculateExpiryStatus(isoDate) {
   if (!isoDate) return 'missing';
   
   const today = new Date();
   today.setHours(0, 0, 0, 0);
   
   const expiry = new Date(isoDate);
   expiry.setHours(0, 0, 0, 0);
   
   const diffDays = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
   
   if (diffDays < 0) return 'expired';
   if (diffDays <= CONFIG.EXPIRY_SOON_DAYS) return 'soon';
   return 'ok';
 }
 
 // ============================================
 // PRODUCT MATCHING
 // ============================================
 function matchProduct(gtin14, gtin13) {
   const idx = State.masterIndex;
   
@@ -677,82 +683,82 @@ async function saveMasterData(products, append = false) {
     await DB.clear('master');
     State.masterData.clear();
   }
   
   for (const p of products) {
     await DB.put('master', p);
     State.masterData.set(p.gtin, p.name);
   }
   
   buildMasterIndex();
   updateStats();
 }
 
 // Update master when editing product name
 async function updateMasterFromEdit(gtin, name) {
   if (gtin && name) {
     await DB.put('master', { gtin, name });
     State.masterData.set(gtin, name);
     buildMasterIndex();
   }
 }
 
 // ============================================
 // EXPORT (Custom Format)
 // ============================================
-// Header: RMS | BARCODE (GTIN) | DESCRIPTION | EXPIRY (DDMMYY) | BATCH | QUANTITY
+// Header: RMS | BARCODE (GTIN) | DESCRIPTION | EXPIRY (DDMMYYYY) | BATCH | QUANTITY
 
 function exportTSV() {
   if (State.history.length === 0) {
     showToast('No data to export', 'warning');
     return;
   }
   
-  const headers = ['RMS', 'BARCODE (GTIN)', 'DESCRIPTION', 'EXPIRY (DDMMYY)', 'BATCH', 'QUANTITY'];
+  const headers = ['RMS', 'BARCODE (GTIN)', 'DESCRIPTION', 'EXPIRY (DDMMYYYY)', 'BATCH', 'QUANTITY'];
   const rows = State.history.map(h => [
     h.rms || '',
     h.gtin14 || h.gtin13 || '',
     h.productName || '',
     h.expiryDDMMYY || '',
     h.batch || '',
     h.qty || 1
   ]);
   
   const content = [headers.join('\t'), ...rows.map(r => r.join('\t'))].join('\n');
   downloadFile(content, `pharmatrack-export-${formatDateForFile()}.tsv`, 'text/tab-separated-values');
   
   Haptic.success();
   showToast('TSV exported', 'success');
 }
 
 function exportCSV() {
   if (State.history.length === 0) {
     showToast('No data to export', 'warning');
     return;
   }
   
-  const headers = ['RMS', 'BARCODE (GTIN)', 'DESCRIPTION', 'EXPIRY (DDMMYY)', 'BATCH', 'QUANTITY'];
+  const headers = ['RMS', 'BARCODE (GTIN)', 'DESCRIPTION', 'EXPIRY (DDMMYYYY)', 'BATCH', 'QUANTITY'];
   const rows = State.history.map(h => [
     h.rms || '',
     h.gtin14 || h.gtin13 || '',
     h.productName || '',
     h.expiryDDMMYY || '',
     h.batch || '',
     h.qty || 1
   ]);
   
   const content = [headers, ...rows].map(row =>
     row.map(cell => `"${String(cell || '').replace(/"/g, '""')}"`).join(',')
   ).join('\n');
   
   downloadFile(content, `pharmatrack-export-${formatDateForFile()}.csv`, 'text/csv');
   
   Haptic.success();
   showToast('CSV exported', 'success');
 }
 
 async function downloadBackup() {
   const backup = {
     version: 1,
     app: 'PharmaTrack',
     exportDate: new Date().toISOString(),
     history: State.history,
 
EOF
)
