export function wrapText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const words = text.split(' ');
  let lines: string[] = [];
  let currentLine = words[0];

  for (let i = 1; i < words.length; i++) {
      if (currentLine.length + 1 + words[i].length <= maxLength) {
          currentLine += ' ' + words[i];
      } else {
          lines.push(currentLine);
          currentLine = words[i];
      }
  }
  lines.push(currentLine);

  // If a single word is too long, force split it
  return lines.map(line => {
      if (line.length > maxLength) {
          return line.match(new RegExp('.{1,' + maxLength + '}', 'g'))?.join('\n') || line;
      }
      return line;
  }).join('\n');
}
