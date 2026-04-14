export type ArtifactType =
  | "wireframe_shell"
  | "wireframe_screen"
  | "wireframe_data"
  | "test_harness"
  | "test_definitions";

export type ArtifactStatus = "active" | "inactive" | "generating";

export interface Artifact {
  id: string;
  sessionId: string;
  type: ArtifactType;
  filename: string;
  filePath: string;
  relatedScreenId: string | null;
  status: ArtifactStatus;
  createdAt: string;
  lastModifiedAt: string;
}
