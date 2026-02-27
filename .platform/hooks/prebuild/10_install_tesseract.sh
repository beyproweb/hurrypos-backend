#!/bin/bash
set -euo pipefail

echo "[prebuild] Ensuring Tesseract OCR is installed"

if command -v tesseract >/dev/null 2>&1; then
  echo "[prebuild] Tesseract already installed: $(command -v tesseract)"
else
  if command -v dnf >/dev/null 2>&1; then
    PM="dnf"
  elif command -v yum >/dev/null 2>&1; then
    PM="yum"
  else
    echo "[prebuild] No supported package manager (dnf/yum) found" >&2
    exit 1
  fi

  install_tesseract_pkg() {
    local installed="false"
    for pkg in tesseract tesseract-ocr; do
      if ${PM} install -y "${pkg}" >/tmp/tesseract-install.log 2>&1; then
        installed="true"
        break
      else
        cat /tmp/tesseract-install.log || true
      fi
    done
    [[ "${installed}" == "true" ]]
  }

  enable_crb_if_available() {
    # AL2023 often does not expose a "crb" repo; skip quietly in that case.
    if ${PM} repolist all 2>/dev/null | awk '{print $1}' | grep -qx 'crb'; then
      ${PM} config-manager --set-enabled crb || true
    else
      echo "[prebuild] Repo 'crb' not present on this platform, skipping"
    fi
  }

  echo "[prebuild] Installing via ${PM}"
  if ! install_tesseract_pkg; then
    echo "[prebuild] Default repos do not include tesseract, trying EPEL"
    ${PM} install -y dnf-plugins-core || true
    enable_crb_if_available
    ${PM} install -y epel-release || \
    ${PM} install -y https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm || true
    ${PM} makecache || true
    install_tesseract_pkg || true
  fi

  # Language package names differ across repos; try both naming schemes.
  ${PM} install -y tesseract-langpack-eng tesseract-langpack-tur || true
  ${PM} install -y tesseract-ocr-eng tesseract-ocr-tur || true
fi

if ! command -v tesseract >/dev/null 2>&1; then
  echo "[prebuild] tesseract not found after install, continuing (Paddle fallback enabled)"
  exit 0
fi

echo "[prebuild] Tesseract version:"
tesseract --version

echo "[prebuild] Available languages:"
tesseract --list-langs || true
