// api/v1/health.js

const { handleCors } = require('../../lib/cors');

// This function responds to the path /api/v1/health

module.exports = (req, res) => {
    if (handleCors(req, res)) return;

    // Fulfills the MVP0 requirement for a health check endpoint
    res.status(200).json({
        status: "OK",
        service: "Dossier Registry API",
        version: "MVP0"
    });
};