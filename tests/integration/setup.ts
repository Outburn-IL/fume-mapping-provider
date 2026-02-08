import { execSync } from 'child_process';
import * as path from 'path';

const composeFile = path.join(__dirname, 'docker-compose.yml');
const HAPI_BASE_URL = 'http://localhost:8081/fhir';

export default async function globalSetup() {
  console.log('Checking HAPI FHIR server status...');
  
  try {
    // Check if server is already running and healthy
    try {
      const response = await fetch(`${HAPI_BASE_URL}/metadata`);
      if (response.ok) {
        console.log('HAPI FHIR server is already running and healthy!');
        return;
      }
    } catch {
      // Server not running or not ready, need to start it
    }

    console.log('Starting HAPI FHIR server...');
    
    // Start the containers (will use existing if already created)
    execSync(`docker compose -f "${composeFile}" up -d`, {
      stdio: 'inherit',
      cwd: __dirname
    });

    // Wait for server to be ready by polling the metadata endpoint
    console.log('Waiting for HAPI FHIR server to be ready...');
    const maxAttempts = 60;
    const delayMs = 2000;
    
    for (let i = 0; i < maxAttempts; i++) {
      try {
        // Try to fetch metadata endpoint
        const response = await fetch(`${HAPI_BASE_URL}/metadata`);
        if (response.ok) {
          console.log('HAPI FHIR server is ready!');
          // Give it a bit more time to fully stabilize
          await new Promise(resolve => setTimeout(resolve, 2000));
          return;
        }
      } catch {
        // Server not ready yet
      }
      
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    
    throw new Error('HAPI FHIR server failed to start within timeout');
  } catch (error) {
    console.error('Failed to start HAPI FHIR server:', error);
    throw error;
  }
}
