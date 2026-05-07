const fs = require('fs');
let code = fs.readFileSync('streamvault/src/App.jsx', 'utf8');

const importStr = "import AuthScreen from './components/AuthScreen.jsx';\n";
if (!code.includes(importStr)) {
  code = code.replace(/import TimelineGrid from "\.\/components\/TimelineGrid\.jsx";\r?\n/, 'import TimelineGrid from "./components/TimelineGrid.jsx";\n' + importStr);
}

// Update the props passed to AuthScreen
code = code.replace(/<AuthScreen onAuth={handleAuth} onGuest={handleGuest} \/>/g, '<AuthScreen onAuth={handleAuth} onGuest={handleGuest} api={API} />');

// Remove the AuthScreen function
const startIdx = code.indexOf('// ── Auth Screen ──');
const endIdx = code.indexOf('// ── Client-side encryption for credentials synced to server ──');

if (startIdx !== -1 && endIdx !== -1) {
  code = code.substring(0, startIdx) + code.substring(endIdx);
  fs.writeFileSync('streamvault/src/App.jsx', code);
  console.log('Removed AuthScreen from App.jsx');
} else {
  console.log('Could not find markers', startIdx, endIdx);
}
