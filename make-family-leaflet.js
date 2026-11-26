const QRCode = require("qrcode");
const Jimp = require("jimp");
const fs = require("fs");

(async () => {
  const candidates = ["leaflet-family-src.png", "leaflet-family-src.jpeg", "leaflet-family-src.jpg", "leaflet-family-src.webp"];
  const input = candidates.find(f => fs.existsSync(f));
  if (!input) { console.error("Could not find leaflet-family file in C:\\Users\\HP\\Desktop\\eduvault"); process.exit(1); }

  await QRCode.toFile("official-qr.png", "https://nigeriapryandsecresultvaults.com", { width: 300, margin: 1 });
  const leaflet = await Jimp.read(input);
  const qr = await Jimp.read("official-qr.png");

  const size = Math.round(leaflet.bitmap.width * 0.152);
  qr.resize(size, size, Jimp.RESIZE_NEAREST_NEIGHBOR);

  const x = Math.round(leaflet.bitmap.width * 0.793);
  const y = Math.round(leaflet.bitmap.height * 0.816);

  leaflet.composite(qr, x, y);
  await leaflet.writeAsync("final-family-leaflet.png");
  console.log("SUCCESS: Saved final-family-leaflet.png!");
})();



