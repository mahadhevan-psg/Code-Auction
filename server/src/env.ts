// Must be the first import in index.ts so every other module sees values from server/.env.
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config(); // also honour a .env in the current directory
