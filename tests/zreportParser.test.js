const assert = require("assert");
const { parseZReportText } = require("../utils/zreportParser");

const cases = [
  {
    name: "TR card total",
    text: "KREDI KARTI 1.234,56 TL\nISLEM ADET 12\nGENEL TOPLAM 2.000,00 TL",
    expect: { card: 1234.56, tx: 12 },
  },
  {
    name: "EN card total",
    text: "CREDIT CARD TOTAL 1,234.56\nTX COUNT 15\nGRAND TOTAL 2,000.00",
    expect: { card: 1234.56, tx: 15 },
  },
  {
    name: "DE card total",
    text: "KARTENZAHLUNG 1.234,56\nANZAHL 8\nGESAMT 2.000,00",
    expect: { card: 1234.56, tx: 8 },
  },
  {
    name: "FR card total",
    text: "TOTAL CARTE 1234,56\nTRANSACTIONS 9\nTOTAL 2000,00",
    expect: { card: 1234.56, tx: 9 },
  },
  {
    name: "TR K KARTI line",
    text: "K KARTI 10\n*2 785,00\nTOPLAM 2 785,00",
    expect: { card: 2785.0, tx: null },
  },
  {
    name: "Do not treat card total as tx count",
    text: "GENEL KART ISLEM TOPLAMI\n2.165,00 TL\nISLEM ADET 7\nRAPOR SONU",
    expect: { card: 2165.0, tx: 7 },
  },
  {
    name: "OCR one-digit decimal in grand total",
    text: "K KARTI 11\n*2 785,00\nTOPLAM 2 785,0 TL",
    expect: { card: 2785.0, tx: null, grand: 2785.0 },
  },
  {
    name: "OCR K KAKI with compact cents",
    text: "K KAKI 10\n+2 78500\nTOPLAM /10 2 785,00",
    expect: { card: 2785.0, tx: null, grand: 2785.0 },
  },
  {
    name: "Grand under-read should fallback to card on card-only slip",
    text: "K KAKI 10\n+2 785,00\nTOPLAM 785,00",
    expect: { card: 2785.0, tx: null, grand: 2785.0 },
  },
  {
    name: "TR satis adet row on same line",
    text: "SEKERBANK - Kart Islemleri\nSATIS 7 ADET 2 165,00\nGENEL KART ISLEM TOPLAMI\n2.165,00 TL",
    expect: { card: 2165.0, tx: 7 },
  },
  {
    name: "Noisy OCR satis row",
    text: "SEKERBANK - Kart Islemleri\nSALLY 7 165 A)\nGENEL KART ISLEM TOPLAMI\n2.165,00 TL",
    expect: { card: 2165.0, tx: 7 },
  },
  {
    name: "Fuzzy bank detection from noisy line",
    text: "SEKERBARK TAS\nGENEL KART ISLEM TOPLAMI\n2.165,00 TL",
    expect: { card: 2165.0, tx: null, bank: "SEKERBANK" },
  },
  {
    name: "Fuzzy bank detection from PEKERBANK / YEKEKBANK noise",
    text: "PE KERBANK | AS\nYEKEKBANK TAS - HART ISLEMLERI - TL\nGENEL KART ISLEM TOPLAMI\n2.165,00 TL",
    expect: { card: 2165.0, tx: null, bank: "SEKERBANK" },
  },
  {
    name: "No labels",
    text: "HELLO WORLD\n1234,56\n",
    expect: { card: null, tx: null },
  },
];

for (const c of cases) {
  const res = parseZReportText(c.text);
  assert.strictEqual(
    res.extracted.card_total,
    c.expect.card,
    `${c.name}: card_total`
  );
  assert.strictEqual(
    res.extracted.tx_count,
    c.expect.tx,
    `${c.name}: tx_count`
  );
  if (Object.prototype.hasOwnProperty.call(c.expect, "grand")) {
    assert.strictEqual(
      res.extracted.grand_total,
      c.expect.grand,
      `${c.name}: grand_total`
    );
  }
  if (Object.prototype.hasOwnProperty.call(c.expect, "bank")) {
    assert.strictEqual(
      res.extracted.bank_name,
      c.expect.bank,
      `${c.name}: bank_name`
    );
  }
}

console.log("✅ zreportParser tests passed");
