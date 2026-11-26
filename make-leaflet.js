const QRCode = require("qrcode");
const Jimp = require("jimp");
const fs = require("fs");

(async () => {
  const input = fs.existsSync("leaflet.png") ? "leaflet.png" : (fs.existsSync("leaflet.jpeg") ? "leaflet.jpeg" : "leaflet.jpg");
  await QRCode.toFile("real-qr.png", "https://nigeriapryandsecresultvaults.com", { width: 260, margin: 1 });
  const leaflet = await Jimp.read(input);
  const qr = await Jimp.read("real-qr.png");
  const size = Math.round(leaflet.bitmap.width * 0.21);
  qr.resize(size, size, Jimp.RESIZE_NEAREST_NEIGHBOR);
  const x = leaflet.bitmap.width - size - Math.round(leaflet.bitmap.width * 0.055);
  const y = leaflet.bitmap.height - size - Math.round(leaflet.bitmap.height * 0.088);
  leaflet.composite(qr, x, y);
  await leaflet.writeAsync("final-leaflet-official.png");
  console.log("SUCCESS: Saved final-leaflet-official.png!");
})();
