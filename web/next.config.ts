import type { NextConfig } from 'next';
import path from 'node:path';
const config: NextConfig = { poweredByHeader: false, outputFileTracingRoot: path.join(process.cwd(), '..') };
export default config;
