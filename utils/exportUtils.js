const PDFDocument = require("pdfkit");
const fs = require("fs");
const {
  getSummary,
  getSalesByPayment,
  getSalesByCategory,
  getCategoryTrends,
  getCashTrends,
  getSalesTrends,
  getExpensesBreakdown,
  getProfitLoss,
} = require("./reportDataService");

// ✅ Compatible currency format
function formatCurrency(val) {
  return `${parseFloat(val).toLocaleString("tr-TR", { minimumFractionDigits: 0 })} TL`;
}

async function generateReportPDF({ from, to, sections }) {
  const doc = new PDFDocument({ margin: 50 });
  const buffers = [];
  doc.on("data", buffers.push.bind(buffers));

  // Optional logo
  const logoPath = "public/logo.png";
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, 50, 40, { width: 80 });
    doc.moveDown(3);
  }

  // Header
  doc.fillColor("#2E3A59").fontSize(20).text("Beypro Business Report", { align: "center" });
  doc.moveDown(0.5);
  doc.fillColor("black").fontSize(11).text(`Date Range: ${from} → ${to}`, { align: "center" });
  doc.text(`Generated on: ${new Date().toLocaleString("tr-TR")}`, { align: "center" });
  doc.moveDown(1.5);

  const sectionData = {};

  for (const section of sections) {
    try {
      switch (section) {
        case "kpis":
          sectionData[section] = await getSummary(from, to);
          break;
        case "salesByPayment":
          sectionData[section] = await getSalesByPayment(from, to);
          break;
        case "salesByCategory":
          sectionData[section] = await getSalesByCategory(from, to);
          break;
        case "categoryTrends":
          sectionData[section] = await getCategoryTrends(from, to);
          break;
        case "cashTrends":
          sectionData[section] = await getCashTrends(from, to);
          break;
        case "salesTrends":
          sectionData[section] = await getSalesTrends(from, to);
          break;
        case "expensesBreakdown":
          sectionData[section] = await getExpensesBreakdown(from, to);
          break;
        case "profitLoss":
          sectionData[section] = await getProfitLoss(from, to);
          break;
        default:
          sectionData[section] = { error: "Unknown section" };
      }
    } catch (err) {
      sectionData[section] = { error: err.message || "Failed to load section" };
    }
  }

  const drawSectionTitle = (title, color = "#2E86AB") => {
    doc.moveDown(1.2);
    doc.fillColor(color).fontSize(13).text(title);
    doc.moveTo(doc.x, doc.y + 2).lineTo(550, doc.y + 2).strokeColor(color).stroke();
    doc.moveDown(0.6);
    doc.fillColor("black");
  };

  for (const section of sections) {
    const data = sectionData[section];
    if (data?.error) {
      drawSectionTitle(`${section.toUpperCase()} (Error)`, "#B00020");
      doc.fillColor("red").text(`Error: ${data.error}`, { indent: 20 });
      doc.fillColor("black");
      continue;
    }

    switch (section) {
      case "kpis":
        drawSectionTitle("KPIs", "#00796B");
        for (const [key, val] of Object.entries(data)) {
          doc.text(`• ${key.replace(/_/g, " ")}: ${formatCurrency(val)}`);
        }
        break;

      case "salesByPayment":
        drawSectionTitle("Sales by Payment Method", "#5C6BC0");
        data.forEach(({ method, value }) => {
          doc.text(`• ${method}: ${formatCurrency(value)}`);
        });
        const paymentTotal = data.reduce((sum, item) => sum + item.value, 0);
        doc.moveDown(0.5);
        doc.font("Helvetica-Bold").text(`Total: ${formatCurrency(paymentTotal)}`, { align: "right" });
        doc.font("Helvetica");
        break;

      case "salesByCategory":
        drawSectionTitle("Sales by Category", "#8E44AD");
        data.forEach(({ category, total }) => {
          doc.text(`• ${category}: ${formatCurrency(total)}`);
        });
        const categoryTotal = data.reduce((sum, item) => sum + item.total, 0);
        doc.moveDown(0.5);
        doc.font("Helvetica-Bold").text(`Total: ${formatCurrency(categoryTotal)}`, { align: "right" });
        doc.font("Helvetica");
        break;

      case "categoryTrends":
        drawSectionTitle("Category Trends", "#007BB6");
        data.forEach((row) => {
          const { date, ...categories } = row;
          doc.text(`${date}`);
          for (const [cat, val] of Object.entries(categories)) {
            doc.text(`   ↳ ${cat}: ${formatCurrency(val)}`);
          }
        });
        break;

      case "cashTrends":
        drawSectionTitle("Cash Register Trends", "#D84315");
        data.forEach(({ date, opening_cash, closing_cash }) => {
          doc.text(`${date} | Opening: ${formatCurrency(opening_cash)} → Closing: ${formatCurrency(closing_cash)}`);
        });
        break;

      case "salesTrends":
        drawSectionTitle("Sales Trends", "#388E3C");
        data.forEach(({ label, sales }) => {
          doc.text(`• ${label}: ${formatCurrency(sales)}`);
        });
        const salesTrendTotal = data.reduce((sum, item) => sum + item.sales, 0);
        doc.moveDown(0.5);
        doc.font("Helvetica-Bold").text(`Total: ${formatCurrency(salesTrendTotal)}`, { align: "right" });
        doc.font("Helvetica");
        break;

      case "expensesBreakdown":
        drawSectionTitle("Expenses Breakdown", "#F57C00");
        data.forEach(({ type, total }) => {
          doc.text(`• ${type}: ${formatCurrency(total)}`);
        });
        const expensesTotal = data.reduce((sum, item) => sum + item.total, 0);
        doc.moveDown(0.5);
        doc.font("Helvetica-Bold").text(`Total: ${formatCurrency(expensesTotal)}`, { align: "right" });
        doc.font("Helvetica");
        break;

      case "profitLoss":
        drawSectionTitle("Profit / Loss by Day", "#6A1B9A");
        data.forEach(({ date, profit, loss }) => {
          doc.text(`${date} | Profit: ${formatCurrency(profit)} | Loss: ${formatCurrency(loss)}`);
        });
        break;

      default:
        doc.text(`Unknown section: ${section}`);
    }

    doc.moveDown(1.2);
  }

  doc.end();
  return new Promise((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(buffers)));
  });
}

module.exports = {
  generateReportPDF,
};
