// services/erp/erpApiError.js — HTTP-facing error of the ERP admin/sync services (status + machine code + safe details).
class ErpApiError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = "ErpApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
module.exports = { ErpApiError };
