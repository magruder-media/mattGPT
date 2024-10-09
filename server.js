const express = require('express');
const http = require('http');
const cors = require('cors');
const { spawn } = require('child_process');

const app = express();

// Enable CORS for all routes
app.use(cors());
app.use(express.json());

let currentProcess = null;

// Endpoint to commence the command execution
app.get('/commence', (req, res) => {
    // If there is a currently running process, kill it
    if (currentProcess) {
        console.log('Killing the current process...');
        currentProcess.kill(); // Kill the current process
        currentProcess = null; // Reset the current process reference
    }

    // Set the headers to keep the connection open
    res.setHeader('Content-Type', 'text/plain');

    // Spawn a new child process
    currentProcess = spawn('node', ['email.js']);

    // Log stdout and stderr in real time and send to the client
    currentProcess.stdout.on('data', (data) => {
        console.log(`${data}`);
        res.write(`${data}`);
    });

    currentProcess.stderr.on('data', (data) => {
        console.error(`${data}`);
        res.write(`${data}`);
    });

    currentProcess.on('error', (error) => {
        console.error(`Error executing command: ${error.message}`);
        res.status(500).send('An error occurred while starting the process.');
    });

    currentProcess.on('close', (code) => {
        console.log(`Child process exited with code ${code}`);
        res.write(`Child process exited with code ${code}\n`);
        res.end(); // End the response
        currentProcess = null; // Reset the current process reference

        // Clean up listeners (if necessary)
        currentProcess.stdout.removeAllListeners();
        currentProcess.stderr.removeAllListeners();
    });
});

// Start the HTTP server
const PORT = 3030; // Change to your desired port
http.createServer(app).listen(PORT, () => {
    console.log(`Server is running at http://192.168.1.234:${PORT}`);
});
