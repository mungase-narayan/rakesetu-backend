export { emailJobs } from "../../schema";
export type { EmailJob, NewEmailJob } from "../../schema";

export { default as EmailJobService } from "./services/email-job.service";
export { emailJobService, mailService } from "./email.provider";
export {
  EMAIL_MAX_ATTEMPTS,
  type EnqueueEmailInput,
} from "./types/email-job.types";
