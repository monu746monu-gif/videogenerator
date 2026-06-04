import { Composition } from "remotion";
import { registerRoot } from "remotion";
import { LaunchVideo } from "./LaunchVideo";
import type { StoryboardScene } from "@/lib/types";

const fps = 30;
const defaultScenes: StoryboardScene[] = [
  {
    sceneNumber: 1,
    headline: "Turn any website into a launch video",
    subtext: "Paste a link, get a storyboard, render a vertical MP4.",
    voiceover: "Launch videos can start with a website link.",
    duration: 5,
    visualDescription: "Use website screenshot with dark overlay."
  }
];

export const RemotionRoot = () => (
  <Composition
    id="LaunchVideo"
    component={LaunchVideo}
    width={1080}
    height={1920}
    fps={fps}
    durationInFrames={150}
    defaultProps={{
      scenes: defaultScenes,
      screenshotSrc: ""
    }}
    calculateMetadata={({ props }) => {
      const scenes = Array.isArray(props.scenes) && props.scenes.length > 0 ? props.scenes : defaultScenes;
      return {
        durationInFrames: scenes.reduce((total, scene) => total + Math.round((scene.duration || 5) * fps), 0)
      };
    }}
  />
);

registerRoot(RemotionRoot);
