const ESC = '\u001b';
const CSI = `${ESC}[`;

if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
  process.stderr.write('FERRUM_TUI_NOT_A_REAL_TTY\n');
  process.exit(2);
}

let typed = '';
let exiting = false;

function line(row, text, style = '') {
  process.stdout.write(`${CSI}${row};1H${CSI}2K${style}${text}${CSI}0m`);
}

function placeCursor() {
  process.stdout.write(`${CSI}10;10H`);
}

function renderSize() {
  line(4, `SIZE:${process.stdout.columns}x${process.stdout.rows}`);
  placeCursor();
}

function finish(code = 0) {
  if (exiting) return;
  exiting = true;
  line(9, `EXIT:${code}`);
  process.stdout.write(`${CSI}?1049l`);
  try { process.stdin.setRawMode(false); } catch {}
  process.stdin.pause();
  setTimeout(() => process.exit(code), 10).unref();
}

process.stdout.write(`${CSI}?1049h${CSI}2J${CSI}H${ESC}]0;Ferrum TUI Fixture\u0007`);
line(1, 'FERRUM TUI FIXTURE', `${CSI}1;36m`);
line(2, 'READY');
line(3, 'TTY:yes');
renderSize();
line(5, 'TYPE:');
line(6, 'KEY:none');
line(7, 'ASYNC:pending');
line(8, 'BELL:sent');
process.stdout.write('\u0007');
placeCursor();

setTimeout(() => {
  if (!exiting) {
    line(7, 'ASYNC:ready');
    placeCursor();
  }
}, 120).unref();

process.stdout.on('resize', () => {
  if (!exiting) renderSize();
});

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  for (const ch of chunk) {
    if (ch === ESC) {
      line(6, 'KEY:ESCAPE');
      placeCursor();
      continue;
    }
    if (ch === 'r') {
      renderSize();
      continue;
    }
    if (ch === 'q') {
      finish(0);
      return;
    }
    if (ch === '\u0003') {
      finish(130);
      return;
    }
    if (ch >= ' ' && ch !== '\u007f') {
      typed += ch;
      line(5, `TYPE:${typed}`);
      placeCursor();
    }
  }
});

process.on('SIGTERM', () => finish(143));
process.on('SIGHUP', () => finish(129));
