const ExcelJS = require('exceljs');
(async () => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Test');
  sheet.getColumn(1).width = 52.4;

  const buf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const imageId = wb.addImage({ buffer: buf, extension: 'png' });

  sheet.addImage(imageId, {
    tl: { col: 0.15, row: 1.25 },
    ext: { width: 100, height: 30 },
  });

  const outBuf = await wb.xlsx.writeBuffer();
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(outBuf);
  const sheet2 = wb2.getWorksheet('Test');
  const images = sheet2.getImages();
  const r = images[0].range;
  console.log('tl:', JSON.stringify(r.tl));
  console.log('br:', JSON.stringify(r.br));
  console.log('ext:', JSON.stringify(r.ext));
})();
