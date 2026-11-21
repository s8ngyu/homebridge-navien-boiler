// Shapes follow real NR-40D reports collected upstream; identifiers are made up.
export const RAW = {
  deviceSeq: 77,
  serviceCode: 100,
  deviceId: 'A1B2C3D4E5F60002',
  modelCode: '002',
  modelName: 'NR-35D',
  mqttTopicKey: 'topickey-test',
  connected: 1,
  Properties: { nickName: { mainItem: '우리집 보일러' } },
};
export const FEATURE = {
  powerUse: 2, gooutUse: 2, hotWaterUse: 2,
  insideUse: 3, insideTemperatureMin: 10, insideTemperatureMax: 40,
  ondolUse: 3, ondolTemperatureMin: 40, ondolTemperatureMax: 83,
  hotWaterTemperatureSettingUse: 3, hotWaterTemperatureMin: 30, hotWaterTemperatureMax: 60,
};
export const STATUS = {
  operationMode: 5, insideTemperature: 25, insideTemperatureSetting: 24,
  ondolTemperatureSetting: 45, hotWaterTemperatureSetting: 42, errorCode: 0,
};
