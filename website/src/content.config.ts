import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { docId, isExcluded } from './lib/docs-links.mjs';

// The docs collection reads the repo's own `docs/` markdown in place (../docs relative to
// this project root). Nothing is copied or forked.
const docs = defineCollection({
  loader: glob({
    pattern: ['**/*.md', '!planning/**', '!reports/evidence/**'],
    base: '../docs',
    generateId: ({ entry }) => {
      if (isExcluded(entry)) throw new Error(`excluded doc leaked into collection: ${entry}`);
      return docId(entry) || 'index';
    },
  }),
  schema: z.object({}).passthrough(),
});

export const collections = { docs };
