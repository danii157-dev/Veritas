import PDFDocument from 'pdfkit';

export function generatePaymentReceiptPdf(receipt) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: 'A4',
      margins: { top: 54, right: 52, bottom: 52, left: 52 },
      info: { Title: receipt.documentType || 'Payment confirmation', Author: 'Veritas Private Bank' },
    });
    const chunks = [];
    const contentWidth = document.page.width - document.page.margins.left - document.page.margins.right;
    const isCredit = receipt.documentType === 'ACCOUNT CREDIT CONFIRMATION';
    document.on('data', (chunk) => chunks.push(chunk));
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));

    const drawHeader = (continued = false) => {
      document.rect(0, 0, document.page.width, 106).fill('#10283a');
      document.rect(0, 103, document.page.width, 3).fill('#c7aa73');
      document.fillColor('#c7aa73').font('Helvetica-Bold').fontSize(8).text('VERITAS', 52, 31);
      document.fillColor('#ffffff').font('Helvetica-Bold').fontSize(17).text('PRIVATE BANK', 52, 45);
      document.fillColor('#d9e3e6').font('Helvetica').fontSize(9).text(continued ? 'TRANSACTION RECORD · CONTINUED' : (receipt.documentType || 'PAYMENT CONFIRMATION').toUpperCase(), 52, 76);
      document.y = 128;
    };

    const ensureSpace = (height) => {
      if (document.y + height <= document.page.height - document.page.margins.bottom) return;
      document.addPage();
      drawHeader(true);
    };

    const addSection = (title) => {
      ensureSpace(32);
      document.moveDown(0.4);
      document.fillColor('#9b835c').font('Helvetica-Bold').fontSize(8).text(title.toUpperCase(), document.page.margins.left, document.y);
      document.moveDown(0.45);
      document.strokeColor('#dfe5e7').lineWidth(0.7).moveTo(document.page.margins.left, document.y).lineTo(document.page.width - document.page.margins.right, document.y).stroke();
      document.moveDown(0.65);
    };

    const addFieldRows = (fields) => {
      const gap = 22;
      const columnWidth = (contentWidth - gap) / 2;
      for (let index = 0; index < fields.length; index += 2) {
        const row = fields.slice(index, index + 2).map(([label, rawValue]) => {
          const value = String(rawValue || 'Not provided');
          const valueHeight = document.font('Helvetica').fontSize(10).heightOfString(value, { width: columnWidth, lineGap: 2 });
          return { label, value, valueHeight };
        });
        const rowHeight = Math.max(...row.map((field) => 31 + field.valueHeight));
        ensureSpace(rowHeight + 10);
        const top = document.y;
        row.forEach((field, column) => {
          const x = document.page.margins.left + column * (columnWidth + gap);
          document.fillColor('#839097').font('Helvetica-Bold').fontSize(7.5).text(field.label.toUpperCase(), x, top, { width: columnWidth });
          document.fillColor('#233541').font('Helvetica').fontSize(10).text(field.value, x, top + 13, { width: columnWidth, lineGap: 2, breakLine: false });
        });
        document.y = top + rowHeight + 8;
      }
    };

    drawHeader();

    ensureSpace(82);
    const summaryY = document.y;
    document.roundedRect(document.page.margins.left, summaryY, contentWidth, 67, 4).fill('#f1f4f5');
    document.rect(document.page.margins.left, summaryY, 3, 67).fill('#c7aa73');
    document.fillColor('#718087').font('Helvetica').fontSize(8).text(isCredit ? 'AMOUNT CREDITED' : 'TRANSFER AMOUNT', document.page.margins.left + 16, summaryY + 13);
    document.fillColor('#10283a').font('Helvetica-Bold').fontSize(21).text(`${receipt.currency} ${receipt.amount}`, document.page.margins.left + 16, summaryY + 29, { width: contentWidth - 32 });
    document.fillColor('#426d56').font('Helvetica-Bold').fontSize(8).text(String(receipt.status || 'RECORDED').toUpperCase(), document.page.margins.left + contentWidth - 160, summaryY + 16, { width: 145, align: 'right' });
    document.y = summaryY + 82;

    addSection('Transaction details');
    addFieldRows([
      ['Receipt number', receipt.receiptNumber],
      ['Transaction reference', receipt.transactionReference],
      ['Processed at', new Date(receipt.processedAt).toLocaleString('en-US')],
      ['Payment reference', receipt.paymentReference || 'None'],
      ['Description', receipt.description || 'None'],
      ['Payment route', receipt.paymentRail || receipt.documentType],
    ]);

    addSection('Parties and accounts');
    addFieldRows([
      ['Sender', receipt.senderName],
      ['Sender account', receipt.senderAccount],
      [isCredit ? 'Credited customer' : 'Recipient', receipt.recipientName],
      ['Recipient institution', receipt.recipientBankName],
      ['Recipient country', receipt.recipientCountry],
      ['Account identifier', `${receipt.recipientAccountIdentifierType || 'Account'} · ${receipt.recipientAccountIdentifier || 'Not provided'}`],
      ['Routing identifier', receipt.recipientRoutingIdentifier],
      ['BIC / SWIFT', receipt.recipientBic],
    ]);

    addSection('Amount summary');
    addFieldRows([
      ['Amount', `${receipt.currency} ${receipt.amount}`],
      ['Fee', `${receipt.currency} ${receipt.fee}`],
      [isCredit ? 'Total credited' : 'Total debited', `${receipt.currency} ${receipt.totalDebit}`],
      ['Previous balance', receipt.previousBalance ? `${receipt.currency} ${receipt.previousBalance}` : 'Not provided'],
      ['New balance', receipt.newBalance ? `${receipt.currency} ${receipt.newBalance}` : 'Not provided'],
    ]);

    if (receipt.disclaimer) {
      const note = String(receipt.disclaimer);
      const noteHeight = document.font('Helvetica').fontSize(8.5).heightOfString(note, { width: contentWidth, lineGap: 2 });
      ensureSpace(noteHeight + 38);
      document.moveDown(0.4);
      document.strokeColor('#dfe5e7').moveTo(document.page.margins.left, document.y).lineTo(document.page.width - document.page.margins.right, document.y).stroke();
      document.moveDown(0.65);
      document.fillColor('#718087').font('Helvetica').fontSize(8.5).text(note, document.page.margins.left, document.y, { width: contentWidth, lineGap: 2 });
    }

    document.end();
  });
}
