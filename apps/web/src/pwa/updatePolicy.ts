export interface UpdateActivationInput {
  waiting: boolean;
  generationActive: boolean;
  userConfirmed: boolean;
}

/** 新 worker 只有在已 waiting、用户显式确认且当前没有生成任务时才可激活。 */
export function canActivateUpdate(input: UpdateActivationInput): boolean {
  return input.waiting && input.userConfirmed && !input.generationActive;
}
