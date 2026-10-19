// Creates the ADMIN_PASSWORD_HASH line for .env. The password itself is never stored anywhere.
// Usage:  npm run hash-password            (asks for the password, input hidden)
//         echo 'my long password' | npm run hash-password --silent
'use strict';
const { hashPassword } = require('../server/auth');

function ask(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let data = ''; stdin.setEncoding('utf8');
      stdin.on('data', (c) => (data += c)); stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      return;
    }
    process.stdout.write(prompt);
    let pw = ''; stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    stdin.on('data', function onData(ch) {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stdout.write('\n'); resolve(pw); }
      else if (ch === '\u0003') process.exit(1);
      else if (ch === '\u007f' || ch === '\b') pw = pw.slice(0, -1);
      else pw += ch;
    });
  });
}

(async () => {
  const pw = await ask('New admin password (min. 12 characters): ');
  if ([...pw].length < 12) { console.error('Password too short: use at least 12 characters (a few random words work well).'); process.exit(1); }
  if (process.stdin.isTTY) {
    const again = await ask('Repeat password: ');
    if (again !== pw) { console.error('Passwords do not match.'); process.exit(1); }
  }
  console.log('\nPut this line in .env (replace any old ADMIN_PASSWORD_HASH line):\n');
  console.log('ADMIN_PASSWORD_HASH=' + hashPassword(pw));
})();
