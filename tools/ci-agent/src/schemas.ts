import { z } from 'zod';

export const ReviewFindingSchema = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  severity: z.enum(['info', 'warning', 'error']),
  confidence: z.enum(['low', 'medium', 'high']),
  message: z.string().min(5),
  suggestion: z.string().optional(),
});

export const ReviewResultSchema = z.object({
  summary: z.string(),
  findings: z.array(ReviewFindingSchema),
});

export const FilePatchSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export const FixProposalSchema = z.object({
  diagnosis: z.string(),
  explanation: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  files: z.array(FilePatchSchema).max(5),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export type FilePatch = z.infer<typeof FilePatchSchema>;
export type FixProposal = z.infer<typeof FixProposalSchema>;
