# picgo-plugin-s3-uploader

> 一个面向 AWS S3、Garage、MinIO 等 S3 兼容对象存储的 PicGo 插件，支持图片删除、输出imgproxy等插件使用的数据字段

它负责把图片上传到 S3 兼容服务，并输出：

- 正常可访问的 `url` / `imgUrl`
- 供 `picgo-plugin-imgproxy` 使用的稳定 `imgproxySource`

## 功能概览

- 支持 AWS S3 / Garage / MinIO 等 S3 兼容服务
- 支持 PicGo GUI 删除图片时同步执行 S3 `DELETE Object`
- 支持 `uploadPath` 上传路径模板
- 支持 `outputURLPattern` 自定义输出 URL 模板
- 内置中英文文案，并优先跟随 PicGo / PicList 当前语言设置

## 安装

### PicGo GUI / PicList

- 可以直接在插件设置页安装 `s3-uploader`
- 也可以安装完整包名 `picgo-plugin-s3-uploader`

### PicGo Core

```bash
picgo install picgo-plugin-s3-uploader
```

## 配置项

| Key | 说明 | 示例 |
| --- | --- | --- |
| `accessKeyID` | S3 Access Key。 | `YOUR_ACCESS_KEY` |
| `secretAccessKey` | S3 Secret Key。 | `YOUR_SECRET_KEY` |
| `bucketName` | 目标 bucket 名称。 | `public` |
| `uploadPath` | 上传路径模板，可使用占位符。 | `img/{year}/{month}/{md5}.{ext}` |
| `outputURLPattern` | 自定义输出 URL 模板；为空时按默认规则推导公开 URL。 | `https://cdn.example.com/{encodedKey}` |
| `region` | 签名区域。AWS 常见为 `us-east-1`；Garage 为 `garage`。 | `us-east-1` |
| `endpoint` | S3 API Endpoint。AWS S3 可留空。必须是完整的 `http://` 或 `https://` 地址。 | `https://minio.example.com` |
| `pathStyleAccess` | 是否使用 path-style 请求。Garage / MinIO 常见为 `true`。 | `true` |
| `rejectUnauthorized` | 是否拒绝无效 TLS 证书。 | `true` |
| `acl` | 对象 ACL；若服务不支持可留空。 | `public-read` |

## 配置示例

### Garage

```json
{
  "picBed": {
    "current": "s3-uploader",
    "uploader": "s3-uploader",
    "s3-uploader": {
      "accessKeyID": "YOUR_ACCESS_KEY",
      "secretAccessKey": "YOUR_SECRET_KEY",
      "bucketName": "public",
      "uploadPath": "img/{year}/{month}/{md5}.{ext}",
      "outputURLPattern": "https://{bucket}.example.com/{encodedKey}",
      "region": "garage",
      "endpoint": "https://garage-api.example.com",
      "pathStyleAccess": true,
      "rejectUnauthorized": true,
      "acl": "public-read"
    }
  }
}
```

### MinIO

```json
{
  "picBed": {
    "current": "s3-uploader",
    "uploader": "s3-uploader",
    "s3-uploader": {
      "accessKeyID": "YOUR_ACCESS_KEY",
      "secretAccessKey": "YOUR_SECRET_KEY",
      "bucketName": "public",
      "uploadPath": "img/{year}/{month}/{fileName:/\\s+/g,'-'}.{extName}",
      "outputURLPattern": "https://cdn.example.com/{encodedKey}",
      "region": "us-east-1",
      "endpoint": "https://minio.example.com",
      "pathStyleAccess": true,
      "rejectUnauthorized": true,
      "acl": "public-read"
    }
  }
}
```

### AWS S3

```json
{
  "picBed": {
    "current": "s3-uploader",
    "uploader": "s3-uploader",
    "s3-uploader": {
      "accessKeyID": "YOUR_ACCESS_KEY",
      "secretAccessKey": "YOUR_SECRET_KEY",
      "bucketName": "public",
      "uploadPath": "img/{year}/{month}/{uuidN}.{extName}",
      "outputURLPattern": "https://cdn.example.com/{encodedKey}",
      "region": "us-east-1",
      "pathStyleAccess": false,
      "rejectUnauthorized": true,
      "acl": "public-read"
    }
  }
}
```

## 模板语法

`uploadPath` 与 `outputURLPattern` 共用同一套模板语法。

### 通用占位符

以下占位符在 `uploadPath` 与 `outputURLPattern` 中都可使用。

| 分类 | 占位符 |
| --- | --- |
| 时间 | `{year}` `{month}` `{day}` `{hour}` `{minute}` `{second}` `{millisecond}` `{timestamp}` `{timestampMS}` |
| 文件 | `{fullName}` `{fileName}` `{filename}` `{basename}` `{name}` `{extName}` `{ext}` |
| 哈希 | `{crc32}` `{md5}` `{md5B64}` `{md5B64Short}` `{sha1}` `{sha256}` |
| 上传上下文 | `{bucket}` `{region}` `{acl}` `{contentType}` `{mime}` `{size}` `{uuid}` `{uuidN}` |
| Endpoint | `{endpoint}` `{endpointOrigin}` `{endpointProtocol}` `{endpointHost}` `{endpointHostname}` `{endpointPort}` `{endpointPath}` `{pathStyleAccess}` |

### `outputURLPattern` 专属占位符

| 占位符 | 说明 |
| --- | --- |
| `{url}` | 插件按默认规则推导出的公开 URL |
| `{origin}` `{protocol}` `{host}` `{hostname}` `{port}` | 默认公开 URL 的主机信息 |
| `{pathname}` | 默认公开 URL 的路径部分，带前导 `/` |
| `{path}` | 默认公开 URL 的路径部分，不带前导 `/` |
| `{key}` `{objectKey}` `{uploadPath}` | 对象 key，未编码 |
| `{encodedKey}` | URL 安全的对象 key |
| `{dir}` | 对象 key 的目录部分，未编码 |
| `{encodedDir}` | URL 安全的目录部分 |
| `{bucketPath}` | `bucket/key` |
| `{encodedBucketPath}` | URL 安全的 `bucket/key` |
| `{eTag}` `{etag}` | 上传返回的 eTag |

### 模板操作语法

下面用一组固定输入说明模板操作语法：

| 字段 | 示例值 |
| --- | --- |
| `bucket` | `public-bucket` |
| `md5` | `2095312189753de6ad47dfe20cbe97ec` |
| `fileName` | `Echo idle 01` |
| `fullName` | `Echo idle 01.png` |

| 写法 | 输入 | 结果 | 说明 |
| --- | --- | --- | --- |
| `{bucket}` | `bucket = public-bucket` | `public-bucket` | 直接取值 |
| `{md5:8}` | `md5 = 2095312189753de6ad47dfe20cbe97ec` | `20953121` | 取前 8 位 |
| `{md5:0,8}` | `md5 = 2095312189753de6ad47dfe20cbe97ec` | `20953121` | 从第 0 位开始取 8 位 |
| `{fileName:/\\s+/g,'-'}` | `fileName = Echo idle 01` | `Echo-idle-01` | 把连续空格替换为 `-` |
| `{fullName:/\\s+/g,'_'}` | `fullName = Echo idle 01.png` | `Echo_idle_01.png` | 把连续空格替换为 `_` |
| `{fullName:/[^A-Za-z0-9._-]+/g,''}` | `fullName = Echo idle 01.png` | `Echoidle01.png` | 移除空格和其他不在白名单内的字符 |

说明：

- `{name:8}` 等价于 `{name:0,8}`
- 正则写法中的 `flags` 可省略
- `replacement` 需要写在单引号里

### 常见模板示例

| 场景 | 模板 | 结果示例 |
| --- | --- | --- |
| 按年月归档 | `img/{year}/{month}/{fullName}` | `img/2026/03/Echo idle 01.png` |
| 用 md5 作为文件名 | `img/{year}/{month}/{md5}.{ext}` | `img/2026/03/2095312189753de6ad47dfe20cbe97ec.png` |
| 把空格替换为 `-` | `img/{fileName:/\\s+/g,'-'}.{extName}` | `img/Echo-idle-01.png` |
| 输出到 CDN | `https://cdn.example.com/{encodedKey}` | `https://cdn.example.com/img/Echo-idle-01.png` |
| bucket 作为子域名 | `https://{bucket}.cdn.example.com/{encodedKey}` | `https://public.cdn.example.com/img/Echo-idle-01.png` |

### `outputURLPattern` 使用建议

如果你是在拼装最终公开 URL，优先使用：

| 推荐占位符 | 原因 |
| --- | --- |
| `{encodedKey}` | 对中文、空格和特殊字符更安全 |
| `{path}` / `{pathname}` | 可以直接复用默认推导出的路径结构 |
| `{encodedBucketPath}` | 适合自行拼接 `bucket/key` |

## `endpoint` 规则

| 项目 | 说明 |
| --- | --- |
| 填写内容 | `endpoint` 填的是 S3 API 地址，不是 CDN 域名或公开访问域名 |
| AWS S3 | 可留空，插件会根据 `region` 自动推导 |
| 协议要求 | 必须写完整的 `http://` 或 `https://` |
| 禁止内容 | 不允许带 query / hash |
| 域名分离场景 | 如果公开访问域名和 API 地址不同，请把公开域名写到 `outputURLPattern` |
| 自动归一化 | 若误把 bucket 写进 `endpoint` 的 host 或 path，插件会自动去重 |

## 默认公开 URL 推导规则

当 `outputURLPattern` 为空时：

| 条件 | 结果 |
| --- | --- |
| `endpoint` 已设置，`pathStyleAccess = true` | `https://endpoint/bucket/key` |
| `endpoint` 已设置，`pathStyleAccess = false` | `https://bucket.endpoint/key` |
| `endpoint` 未设置 | 按 AWS 官方 S3 域名规则结合 `region` 自动推导 |

如果你的 API Endpoint、公开访问域名、CDN 域名不是同一个地址，建议显式配置 `outputURLPattern`。

## 上传成功后写入的字段

这些字段可供其他插件继续消费，尤其是 `picgo-plugin-imgproxy`。

| 字段 | 说明 | 示例 |
| --- | --- | --- |
| `uploadPath` | 对象 key | `img/Echo-idle-01.png` |
| `eTag` | 上传返回的 eTag | `etag-value` |
| `imgproxySource.backend` | 固定为 `s3` | `s3` |
| `imgproxySource.bucket` | bucket 名称 | `public` |
| `imgproxySource.key` | 对象 key | `img/Echo-idle-01.png` |

对应的 S3 来源统一为：

```text
s3://bucket/key
```

## 删除支持

PicGo GUI 删除图片时，本插件会监听 `remove` 事件，并对当前插件上传的图片执行 S3 `DELETE Object`。

| 行为 | 说明 |
| --- | --- |
| 删除范围 | 只处理 `type === "s3-uploader"` 的项目 |
| key 来源 | 优先使用 `imgproxySource.key`，没有时回退到 `uploadPath` |
| 不存在对象 | 记为“已不存在”，不视为硬错误 |
| 用户反馈 | 会同时写日志，并在 GUI 中弹出通知 |

## 与 picgo-plugin-imgproxy 联用

当你同时安装：

- `picgo-plugin-s3-uploader`
- `picgo-plugin-imgproxy`

并在 `picgo-plugin-imgproxy` 中开启：

```json
{
  "enableS3Source": true
}
```

`imgproxy` 插件会优先读取本插件写出的：

```json
{
  "imgproxySource": {
    "backend": "s3",
    "bucket": "public",
    "key": "img/Echo-idle-01.png"
  }
}
```

并据此生成s3格式的链接进行处理：

```text
/rs:fit:300:300/plain/s3://public/img/Echo-idle-01.png
```

