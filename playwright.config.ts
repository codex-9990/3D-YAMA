import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'tests/e2e',timeout:180000,workers:1,fullyParallel:false,use:{baseURL:'http://127.0.0.1:4176',viewport:{width:1440,height:1000},headless:true,screenshot:'only-on-failure'},webServer:{command:'pnpm preview --port 4176',url:'http://127.0.0.1:4176',reuseExistingServer:true},reporter:[['list']]});
