// scripts/run-create-post-job.ts
import { createPostJob } from '../src/jobs/handlers/createPostJob';

async function main() {
  const fakeJob = {
    id: 'local-test-job',
    attempts: 0,
    payload: {}
  };

  await createPostJob(fakeJob);

  console.log('✅ createPostJob ejecutado en modo local');
}

main().catch((err) => {
  console.error('❌ Error ejecutando createPostJob local:', err);
  process.exit(1);
});
