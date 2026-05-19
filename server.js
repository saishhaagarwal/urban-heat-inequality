const http = require("http");

const PORT = 3000;

// Simple request handler
function handleRequest(req, res) {

    // Home route
    if (req.url === "/") {

        res.writeHead(200, {
            "Content-Type": "text/plain"
        });

        res.end("Server is running");
    }

    // API route
    else if (req.url === "/api/cities") {

        const cities = [
            "Pune",
            "Mumbai",
            "Delhi"
        ];

        res.writeHead(200, {
            "Content-Type": "application/json"
        });

        res.end(JSON.stringify(cities));
    }

    // Unknown route
    else {

        res.writeHead(404, {
            "Content-Type": "text/plain"
        });

        res.end("Route not found");
    }
}

// Create server
const server = http.createServer(handleRequest);

// Start server
server.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});