import {
  AbsoluteFill,
  Img,
  interpolate,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig
} from "remotion";
import type { StoryboardScene } from "@/lib/types";

type LaunchVideoProps = {
  scenes: StoryboardScene[];
  screenshotSrc: string;
};

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

export function LaunchVideo({ scenes = defaultScenes, screenshotSrc }: LaunchVideoProps) {
  const { fps } = useVideoConfig();
  let from = 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "#090B12" }}>
      {scenes.map((scene) => {
        const durationInFrames = Math.round(scene.duration * fps);
        const start = from;
        from += durationInFrames;

        return (
          <Sequence key={scene.sceneNumber} from={start} durationInFrames={durationInFrames}>
            <Scene scene={scene} screenshotSrc={screenshotSrc} durationInFrames={durationInFrames} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}

function Scene({
  scene,
  screenshotSrc,
  durationInFrames
}: {
  scene: StoryboardScene;
  screenshotSrc: string;
  durationInFrames: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fadeIn = interpolate(frame, [0, 14], [0, 1], { extrapolateRight: "clamp" });
  const fadeOut = interpolate(frame, [durationInFrames - 16, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp"
  });
  const textLift = spring({ frame, fps, config: { damping: 18, stiffness: 90 } });
  const zoom = interpolate(frame, [0, durationInFrames], [1, 1.08]);
  const opacity = Math.min(fadeIn, fadeOut);

  return (
    <AbsoluteFill style={{ opacity }}>
      {screenshotSrc ? (
        <Img
          src={screenshotSrc}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: `scale(${zoom})`
          }}
        />
      ) : null}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, rgba(4,8,16,0.45) 0%, rgba(4,8,16,0.78) 48%, rgba(4,8,16,0.92) 100%)"
        }}
      />
      <AbsoluteFill
        style={{
          justifyContent: "flex-end",
          padding: "0 82px 170px",
          transform: `translateY(${interpolate(textLift, [0, 1], [40, 0])}px)`
        }}
      >
        <div
          style={{
            color: "#A7F3D0",
            fontFamily: "Arial, Helvetica, sans-serif",
            fontSize: 34,
            fontWeight: 700,
            marginBottom: 28
          }}
        >
          Scene {scene.sceneNumber}
        </div>
        <div
          style={{
            color: "white",
            fontFamily: "Arial, Helvetica, sans-serif",
            fontSize: 82,
            lineHeight: 1.03,
            fontWeight: 800,
            letterSpacing: 0,
            marginBottom: 36
          }}
        >
          {scene.headline}
        </div>
        <div
          style={{
            color: "#E5E7EB",
            fontFamily: "Arial, Helvetica, sans-serif",
            fontSize: 42,
            lineHeight: 1.25,
            fontWeight: 500,
            maxWidth: 900
          }}
        >
          {scene.subtext}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
