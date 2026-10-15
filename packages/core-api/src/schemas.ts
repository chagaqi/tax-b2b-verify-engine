import { z } from 'zod';

const country = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'Use an ISO 3166-1 alpha-2 code (EL and XI are accepted)')
  .transform((s) => s.toUpperCase());

export const VerifyTaxIdSchema = z
  .object({
    taxId: z.string().trim().min(2).max(64),
    country: country.optional(),
    liveLookup: z.boolean().default(true),
    certificate: z.boolean().default(false),
    companyName: z.string().trim().max(200).optional(),
    domain: z.string().trim().max(253).optional(),
    email: z.string().trim().max(320).optional(),
    /** Also run domain enrichment for `domain`/`email` (counts against the enrichment quota). */
    enrich: z.boolean().default(false),
    fresh: z.boolean().default(false),
  })
  .strict();
export type VerifyTaxIdInput = z.infer<typeof VerifyTaxIdSchema>;

export const EnrichCompanySchema = z
  .object({
    email: z.string().trim().max(320).optional(),
    domain: z.string().trim().max(253).optional(),
    include: z
      .object({ rdap: z.boolean().default(true), metadata: z.boolean().default(true) })
      .strict()
      .default({ rdap: true, metadata: true }),
  })
  .strict()
  .refine((v) => Boolean(v.email || v.domain), { message: 'Provide `email` or `domain`' });
export type EnrichCompanyInput = z.infer<typeof EnrichCompanySchema>;

export const InstallSchema = z
  .object({
    platform: z.enum(['direct', 'makecom']).default('direct'),
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().max(320).optional(),
  })
  .strict();
