const conn = { server: 'http://imediatv666.store:7777', user: 'testuser', pass: 'testpass' };
const program = { start: '2026-04-30T23:00:00Z' };
const durationMin = 60;
const streamId = '112358';

const d = new Date(program.start);
const pad = (n) => String(n).padStart(2, '0');
const startFmt = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}:${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`;
const tsUrl = `${conn.server}/streaming/timeshift.php?username=${encodeURIComponent(conn.user)}&password=${encodeURIComponent(conn.pass)}&stream=${streamId}&start=${startFmt}&duration=${durationMin}`;

console.log('Generated URL:', tsUrl);
