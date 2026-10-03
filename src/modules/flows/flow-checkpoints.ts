import { Injectable } from '@nestjs/common';
import { FlowCheckpoint } from './flow.types';


@Injectable()
export class FlowCheckpoints {
  async reached(_point: FlowCheckpoint, _flow: { readonly flowId: string; readonly state: string }): Promise<void> {
  }
}
