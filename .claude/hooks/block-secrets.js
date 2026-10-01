// PreToolUse hook: block writes that appear to contain credentials.
// Exit code 2 blocks the tool call and feeds stderr back to Claude.
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const patterns = [
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /sk-ant-[A-Za-z0-9_-]{20,}/,
    /ghp_[A-Za-z0-9]{36}/,
  ];
  if (patterns.some((p) => p.test(input))) {
    console.error('Blocked: content looks like a secret. Use environment variables instead.');
    process.exit(2);
  }
});
