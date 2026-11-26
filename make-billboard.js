const QRCode = require("qrcode");
const Jimp = require("jimp");
const fs = require("fs");

(async () => {
  const candidates = ["billboard-src.png", "billboard-src.jpeg", "billboard-src.jpg", "billboard-src.webp"];
  const input = candidates.find(f => fs.existsSync(f));
  if (!input) { console.error("Billboard image not found."); process.exit(1); }

  await QRCode.toFile("official-qr.png", "https://nigeriapryandsecresultvaults.com", { width: 400, margin: 1 });
  const board = await Jimp.read(input);
  const qr = await Jimp.read("official-qr.png");

  const size = Math.round(board.bitmap.width * 0.095);
  qr.resize(size, size, Jimp.RESIZE_NEAREST_NEIGHBOR);

  const x = Math.round(board.bitmap.width * 0.892);
  const y = Math.round(board.bitmap.height * 0.755);

  board.composite(qr, x, y);
  await board.writeAsync("final-school-billboard.png");
  console.log("SUCCESS: Saved final-school-billboard.png!");
})();
