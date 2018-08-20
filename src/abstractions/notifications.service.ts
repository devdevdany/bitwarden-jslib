import { EnvironmentService } from './environment.service';

export abstract class NotificationsService {
    init: (environmentService: EnvironmentService) => Promise<void>;
    updateConnection: () => Promise<void>;
}