
import { db } from './lib/db/src/index.ts';
import { generationsTable } from './lib/db/src/schema/generations.ts';

async function check() {
  try {
    const lastGens = await db.select().from(generationsTable).limit(10);
    console.log('Last 10 generations:');
    console.table(lastGens.map(g => ({
      id: g.id,
      status: g.status,
      count: g.cardCount,
      error: g.errorMessage,
      created: g.createdAt
    })));
  } catch (err) {
    console.error('DB check failed:', err);
  } finally {
    process.exit();
  }
}

check();
