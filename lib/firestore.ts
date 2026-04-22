import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';

const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.QA_PROJECT_ID || '<your-gcp-project>';
const app = initializeApp({ projectId }, 'qa-platform');
export const db = getFirestore(app);
export { FieldValue };

export const COLLECTIONS = {
  CANARY_RUNS: 'qa_canary_runs',
  FINDINGS: 'qa_findings',
  AGENT_SESSIONS: 'qa_agent_sessions',
  FLAKY_TESTS: 'qa_flaky_tests',
} as const;
