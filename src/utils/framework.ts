/**
 * Detect framework from requirements string
 * Parses requirements.txt style content to find torch/pytorch
 */
export function detectFramework(requirements: string | undefined): 'pytorch' | undefined {
  if (!requirements) {
    return 'pytorch'; // default (todo: remove from being the default)      
  }

  const lower = requirements.toLowerCase();

  // Look for torch or pytorch in requirements
  // Common patterns: "torch", "torch==2.0", "pytorch", "torch>=1.0"
  if (lower.includes('torch')) {
    return 'pytorch';
  }

  return undefined;
}
