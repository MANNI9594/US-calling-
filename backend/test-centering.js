const ExcelJS = require('exceljs');
(async () => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Test');
  sheet.getColumn(1).width = 52.4; // matches real column L width

  // Create a tiny fake PNG buffer (1x1 red pixel) just to get addImage to accept something
  const buf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const imageId = wb.addImage({ buffer: buf, extension: 'png' });

  // Try fractional col/row offset to center a smaller image within a cell
  sheet.addImage(imageId, {
    tl: { col: 0.15, row: 1.25 }, // fractional offset within column 0 / row 1
    ext: { width: 100, height: 30 },
  });

  const outBuf = await wb.xlsx.writeBuffer();
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(outBuf);
  const sheet2 = wb2.getWorksheet('Test');
  const images = sheet2.getImages();
  console.log('Image anchor after round-trip:', JSON.stringify(images[0].range, null, 2));
})();
