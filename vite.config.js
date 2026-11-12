import { defineConfig } from 'vite';

// Relative base so the build works both at a domain root and under /<repo>/ on GitHub Pages.
export default defineConfig({ base: './' });
