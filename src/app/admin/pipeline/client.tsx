"use client";

import { PipelineSection } from "../sections/pipeline-section";
import { createStatusWorkspaceClient } from "../status-workspace-client";

export default createStatusWorkspaceClient(PipelineSection);
