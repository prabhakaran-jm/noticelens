import { NoticeLensApp, type CloudDraftProbe } from "./ui/production/NoticeLensApp";

export function App(props?: { cloudDraftProbe?: CloudDraftProbe }) {
  return <NoticeLensApp cloudDraftProbe={props?.cloudDraftProbe} />;
}
