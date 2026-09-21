import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';

// Generates a GENERIC sample aptitude practice set so the system can be tested
// without any private/copyrighted sources. Not based on any real book or test.
const out = path.join(config.sourcesDir, 'sample-aptitude-test.pdf');
fs.mkdirSync(config.sourcesDir, { recursive: true });

const doc = new PDFDocument({ size: 'A4', margin: 54 });
const stream = fs.createWriteStream(out);
doc.pipe(stream);

const H1 = (t: string) => doc.moveDown(0.5).fontSize(16).fillColor('#111').text(t).moveDown(0.3);
const SEC = (t: string) => doc.moveDown(0.6).fontSize(13).fillColor('#1a3d7c').text(t).moveDown(0.2).fillColor('#111');
const Q = (t: string) => doc.fontSize(11).text(t, { lineGap: 2 }).moveDown(0.15);
const C = (t: string) => doc.fontSize(11).text('   ' + t).moveDown(0.05);

doc.fontSize(20).text('Sample Aptitude & Reasoning Practice Set', { align: 'center' });
doc.moveDown(0.3).fontSize(10).fillColor('#666').text('Generic demo document for testing the MCP ingestion pipeline.', { align: 'center' });
doc.fillColor('#111');

SEC('Section 1 — Numerical Reasoning');
Q('1. A shirt priced at 80 is sold at a 25% discount. What is the discounted price?');
C('A) 55'); C('B) 60'); C('C) 65'); C('D) 70');
Q('2. If the ratio of boys to girls in a class is 3:2 and there are 30 boys, how many girls are there? (Difficulty: Easy)');
C('A) 15'); C('B) 20'); C('C) 25'); C('D) 45');
Q('3. A train travels 240 km in 3 hours. What is its average speed in km/h?');
C('A) 60'); C('B) 70'); C('C) 80'); C('D) 90');
Q('4. What is 15% of 15% of 2000? (Difficulty: Hard)');
C('A) 30'); C('B) 45'); C('C) 90'); C('D) 300');

SEC('Section 2 — Sequences and Patterns');
Q('5. Find the next number in the sequence: 2, 6, 12, 20, 30, ?');
C('A) 36'); C('B) 40'); C('C) 42'); C('D) 44');
Q('6. Complete the series: 1, 4, 9, 16, 25, ?');
C('A) 30'); C('B) 36'); C('C) 49'); C('D) 64');
Q('7. What number is missing: 5, 10, 20, 40, ?, 160');
C('A) 60'); C('B) 70'); C('C) 80'); C('D) 100');

SEC('Section 3 — Verbal Reasoning');
Q('8. Choose the word that is the antonym of "abundant".');
C('A) plentiful'); C('B) scarce'); C('C) generous'); C('D) ample');
Q('9. Book is to Reading as Fork is to ?');
C('A) Drawing'); C('B) Writing'); C('C) Eating'); C('D) Stirring');

SEC('Section 4 — Logical Reasoning');
Q('10. All roses are flowers. Some flowers fade quickly. Therefore: which conclusion follows?');
C('A) All roses fade quickly'); C('B) Some roses may fade quickly'); C('C) No roses fade quickly'); C('D) All flowers are roses');

doc.addPage();
SEC('Section 5 — Abstract / Spatial Reasoning (figure-based)');
Q('11. Study the 2x2 matrix of shapes below. Which shape completes the pattern in the empty cell? (Difficulty: Medium)');
// Draw a simple 2x2 matrix of shapes with the bottom-right missing.
const startX = 80;
const startY = doc.y + 10;
const cell = 90;
doc.lineWidth(1).strokeColor('#333');
doc.rect(startX, startY, cell * 2, cell * 2).stroke();
doc.moveTo(startX + cell, startY).lineTo(startX + cell, startY + cell * 2).stroke();
doc.moveTo(startX, startY + cell).lineTo(startX + cell * 2, startY + cell).stroke();
// top-left: circle, top-right: square, bottom-left: triangle, bottom-right: ? 
doc.circle(startX + cell / 2, startY + cell / 2, 25).stroke();
doc.rect(startX + cell + 20, startY + 20, 50, 50).stroke();
doc.moveTo(startX + cell / 2, startY + cell + 20)
  .lineTo(startX + cell / 2 - 28, startY + cell + 70)
  .lineTo(startX + cell / 2 + 28, startY + cell + 70)
  .closePath()
  .stroke();
doc.fontSize(28).fillColor('#999').text('?', startX + cell + 38, startY + cell + 28);
doc.fillColor('#111');
doc.y = startY + cell * 2 + 20;
C('A) Circle'); C('B) Square'); C('C) Triangle'); C('D) Pentagon');
Q('12. Which figure is the odd one out among the shapes shown above?');
C('A) The circle'); C('B) The square'); C('C) The triangle'); C('D) None');

doc.addPage();
H1('Answer Key');
doc.fontSize(11).text('1. B    2. B    3. C    4. B    5. C    6. B', { lineGap: 4 });
doc.text('7. C    8. B    9. C    10. B    11. B    12. A');

doc.moveDown(1);
H1('Solutions');
doc.fontSize(10);
doc.text('1. Explanation: A 25% discount on 80 removes 20, leaving 60.', { lineGap: 3 });
doc.text('2. Explanation: The ratio 3:2 means for every 3 boys there are 2 girls. 30 boys = 10 groups of 3, so girls = 10 x 2 = 20.');
doc.text('3. Explanation: Average speed = distance / time = 240 / 3 = 80 km/h.');
doc.text('5. Explanation: Differences are 4, 6, 8, 10, 12, giving 30 + 12 = 42.');
doc.text('6. Explanation: These are perfect squares; the next after 25 is 36.');
doc.text('9. Explanation: A book is used for reading; a fork is used for eating.');

doc.end();

await new Promise<void>((resolve) => stream.on('finish', () => resolve()));
console.log(`Sample PDF written to ${out}`);
process.exit(0);
