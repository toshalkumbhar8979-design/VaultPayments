'use strict';

const fs = require('fs');
const path = require('path');

// PCI-compliant dedicated append-only logger
// In production, this would ship logs to a WORM (Write Once Read Many) storage

const logDir = path.resolve(__dirname, '../../logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const auditFile = path.join(logDir, 'pci_audit.log');

class PCIAuditLogger {
  logAccess(userId, resource, action, result, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      user_id: userId || 'system',
      event: 'access_cardholder_data',
      resource,
      action,
      result,
      details,
    };

    const logLine = JSON.stringify(entry) + '\n';
    // Append-only sync write to ensure durability of audit logs
    fs.appendFileSync(auditFile, logLine);
  }
}

module.exports = new PCIAuditLogger();
