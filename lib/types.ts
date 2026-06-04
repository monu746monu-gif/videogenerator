export type WebsiteData = {
  url: string;
  title: string;
  description: string;
  headings: string[];
  text: string;
  ogImage: string | null;
  screenshotPath: string;
  screenshotUrl: string;
};

export type StoryboardScene = {
  sceneNumber: number;
  headline: string;
  subtext: string;
  voiceover: string;
  duration: number;
  visualDescription: string;
};

export type StoryboardResponse = {
  scenes: StoryboardScene[];
};
