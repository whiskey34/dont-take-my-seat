import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.whiskey34.donttakemyseat',
  appName: "Don't Take My Seat",
  webDir: 'dist',
  android: {
    // The game never loads remote content.
    allowMixedContent: false,
  },
};

export default config;
