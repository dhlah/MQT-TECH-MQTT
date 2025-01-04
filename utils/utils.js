const prisma = require("./db");
const bcrypt = require("bcrypt");

async function updateStatusDevice(deviceId, payload) {
  const deviceID = deviceId.replace('DEVICE-', '')
  try {
    const status = await prisma.devices.update({
      where: { id: deviceID },
      data: { status: payload },
    });
  } catch (error) {
    console.error(`[ERROR] Saat Update Status Device : ${error}`);
  }
}

async function signInDeviceFunction(username, password) {
  try {
    const device = await prisma.devices.findUnique({
      where: { id: username },
      select: { token: true },
    });
    const tokenMatch = await bcrypt.compare(password, device.token);
    if (tokenMatch) {
      console.log(`[AUTH] Authentication success for ${username}`);
      return true;
    } else {
      console.log(`[AUTH] Token mismatch for ${username}`);
      return false;
    }
  } catch (error) {
    console.error(`[ERROR] Login Device: ${error}`);
    return false;
  }
}

module.exports = {
  updateStatusDevice,
  signInDeviceFunction,
};
