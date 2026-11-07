function valid(value) {
  if (
    typeof value !== "string" ||
    value.length > 180000 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    return false;
  const data = Buffer.from(value.slice(value.indexOf(",") + 1), "base64");
  return (
    data.length >= 24 &&
    data
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.subarray(12, 16).toString() === "IHDR" &&
    data.readUInt32BE(16) > 0 &&
    data.readUInt32BE(16) <= 2000 &&
    data.readUInt32BE(20) > 0 &&
    data.readUInt32BE(20) <= 2000
  );
}
module.exports = { valid };
