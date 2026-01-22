/**
 * Parse memory string to megabytes
 * Accepts: "2GB", "1024MB", or raw number (treated as MB)
 */
export function parseMemory(memory: string | number): number {
  if (typeof memory === 'number') {
    return memory;
  }

  const str = memory.trim().toUpperCase();
  const match = str.match(/^(\d+)\s*(GB|MB)$/);

  if (!match) {
    throw new Error(`Invalid memory format: "${memory}". Use "2GB" or "1024MB".`);
  }

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;

  if (unit === 'GB') {
    return value * 1024;
  }
  return value; // MB
}
