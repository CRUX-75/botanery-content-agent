// scripts/debug-storage.ts
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

async function main() {
  console.log('[DEBUG] Using SUPABASE_URL:', SUPABASE_URL);

  const { data, error } = await supabase.storage.listBuckets();

  if (error) {
    console.error('❌ Error listing buckets:', error);
    process.exit(1);
  }

  console.log('✅ Buckets available in THIS project:');
  for (const b of data ?? []) {
    console.log(`- ${b.name}`);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
