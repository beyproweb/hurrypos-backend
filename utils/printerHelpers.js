// utils/printerHelpers.js
// Shared ESC/POS helpers for printer + cash drawer routes

const escpos = require("escpos");

try {
  escpos.USB = require("escpos-usb");
} catch (err) {
  // optional dependency – ignore if not installed
}

try {
  escpos.Network = require("escpos-network");
} catch (err) {
  // optional dependency – ignore if not installed
}

try {
  escpos.Serial = require("escpos-serialport");
} catch (err) {
  // optional dependency – ignore if not installed
}

try {
  escpos.Bluetooth = require("escpos-bluetooth");
} catch (err) {
  // optional dependency – ignore if not installed
}

function toHex(n) {
  if (typeof n !== "number") return null;
  return "0x" + n.toString(16).padStart(4, "0");
}

function parseHex(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  const parsed = parseInt(normalized, 16);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanErr(err) {
  return (err && (err.message || err.toString())) || "unknown";
}

function makeDevice(rawConfig = {}) {
  const config = {
    ...rawConfig,
    iface: rawConfig.interface || rawConfig.iface,
  };

  const iface = (config.iface || "").toLowerCase();

  if (iface === "usb") {
    if (!escpos.USB) {
      throw new Error("USB support not available. Install 'escpos-usb' and libusb.");
    }
    const vendorId = parseHex(config.vendorId);
    const productId = parseHex(config.productId);
    if (vendorId == null || productId == null) {
      throw new Error("Provide USB vendorId and productId (e.g. 0x04b8).");
    }
    return new escpos.USB(vendorId, productId);
  }

  if (iface === "serial") {
    if (!escpos.Serial) {
      throw new Error("Serial support not available. Install 'escpos-serialport'.");
    }
    if (!config.path) {
      throw new Error("Provide serial 'path' (e.g. /dev/ttyUSB0 or COM3).");
    }
    const baudRate = Number(config.baudRate) || 9600;
    return new escpos.Serial(config.path, { baudRate });
  }

  if (iface === "network") {
    if (!escpos.Network) {
      throw new Error("Network printers not available. Install 'escpos-network'.");
    }
    if (!config.host) {
      throw new Error("Provide network 'host' (printer IP).");
    }
    const port = Number(config.port) || 9100;
    return new escpos.Network(config.host, port);
  }

  if (iface === "bluetooth") {
    if (!escpos.Bluetooth) {
      throw new Error("Bluetooth support not available. Install 'escpos-bluetooth'.");
    }
    const address = config.address || config.mac || config.device;
    if (!address) {
      throw new Error("Provide bluetooth 'address' (e.g. 01:23:45:67:89:ab).");
    }
    return new escpos.Bluetooth(address);
  }

  throw new Error("Unsupported printer interface. Use usb | serial | network | bluetooth.");
}

module.exports = {
  escpos,
  makeDevice,
  cleanErr,
  toHex,
  parseHex,
};
