
const http = require('http');

const data = JSON.stringify({
  type: 'xtream',
  server: 'http://google.com',
  user: 'test',
  pass: 'test'
});

const options = {
  hostname: 'localhost',
  port: 3001,
  path: '/api/diagnose',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log('STATUS:', res.statusCode);
    console.log('BODY:', body);
    process.exit(0);
  });
});

req.on('error', (e) => {
  console.error(`problem with request: ${e.message}`);
  process.exit(1);
});

req.write(data);
req.end();
